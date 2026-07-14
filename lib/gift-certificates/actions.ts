/**
 * Server Actions управления подарочными сертификатами (docs/24 §5).
 *
 * Выпуск / обновление / деактивация — через единый пайплайн defineAction
 * (§4.7 ядра): guard (gift.write) → Zod → handler (модуль-гейт orders + БД) →
 * revalidate('/admin/gift-certificates') → audit ('gift.*'). Права gift.read/write
 * зарегистрированы под модулем orders (lib/auth/permissions).
 *
 * ГРАНИЦА 4a: списание/возврат баланса (redeemGiftTx/releaseGiftTx) в денежный
 * конвейер НЕ включаются здесь — это чекаут/рефанд (4b). Админка только выпускает,
 * правит и отключает сертификаты.
 *
 * i18n: description/terms переводимы — блок translations резолвится через
 * resolveTranslationsUpdate (whitelist GIFT_TR_FIELDS × включённые языки), база
 * (ru) пишется в обычные колонки.
 *
 * ТЕСТИРУЕМОСТЬ без БД/Next: createGiftActions(deps) инъецирует репозиторий и
 * пайплайн; прод-обёртки — productionGiftDeps().
 */
import {
  defineAction,
  defaultDeps,
  PublicActionError,
  type ActionDeps,
} from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import {
  getLocaleConfig,
  resolveTranslationsUpdate,
  type LocaleConfig,
  type TranslationsMap,
} from '@/lib/i18n';
import { toMinor } from '@/lib/orders/money';

import { GIFT_TR_FIELDS } from './fields';
import { GiftCertificateError } from './errors';
import {
  IssueGiftCertificateSchema,
  UpdateGiftCertificateSchema,
  SetGiftStatusSchema,
} from './schemas';
import {
  insertGiftCertificate,
  getGiftCertificateById,
  updateGiftStatus,
  mapGiftCertificate,
  type IssueGiftCertificateRow,
} from './repository';
import { sql } from '@/lib/db/client';
import type { GiftCertificate, GiftCertificateStatus } from './types';

/** Путь раздела сертификатов для инвалидации после мутации. */
const GIFT_LIST_PATH = '/admin/gift-certificates';
function giftPath(id: string): string {
  return `/admin/gift-certificates/${id}`;
}

/** Код нарушения уникальности PostgreSQL (дубликат кода сертификата). */
const PG_UNIQUE_VIOLATION = '23505';
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

/** Зависимости фабрики gift-actions (инъекция для тестов без БД). */
export interface GiftActionDeps {
  actionDeps: ActionDeps;
  isOrdersEnabled: () => Promise<boolean>;
  getLocaleConfig: () => Promise<LocaleConfig>;
  insertGiftCertificate: (row: IssueGiftCertificateRow) => Promise<GiftCertificate>;
  getGiftCertificateById: (id: string) => Promise<GiftCertificate | null>;
  updateGiftStatus: (id: string, status: GiftCertificateStatus) => Promise<boolean>;
  updateGiftFields: (input: UpdateFieldsInput) => Promise<GiftCertificate>;
}

/** Поля обновления, уже разрешённые (translations посчитан). */
export interface UpdateFieldsInput {
  id: string;
  name?: string;
  initialAmount?: string;
  validUntil?: Date | null;
  validUntilProvided: boolean;
  description?: string | null;
  descriptionProvided: boolean;
  terms?: string | null;
  termsProvided: boolean;
  comment?: string;
  translations?: TranslationsMap;
  translationsProvided: boolean;
}

/** Прод-зависимости (реальная БД + дефолтный пайплайн). */
export function productionGiftDeps(): GiftActionDeps {
  return {
    actionDeps: defaultDeps,
    isOrdersEnabled: () => isModuleEffectivelyEnabled('orders'),
    getLocaleConfig,
    insertGiftCertificate,
    getGiftCertificateById,
    updateGiftStatus,
    updateGiftFields: updateGiftFieldsDb,
  };
}

/**
 * UPDATE полей сертификата (partial). Только переданные ключи трогаются
 * (CASE WHEN provided). translations пишется одним UPDATE вместе с базой (ru).
 */
async function updateGiftFieldsDb(input: UpdateFieldsInput): Promise<GiftCertificate> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE gift_certificates SET
      name           = COALESCE(${input.name ?? null}, name),
      initial_amount = COALESCE(${input.initialAmount ?? null}, initial_amount),
      valid_until    = CASE WHEN ${input.validUntilProvided}
                            THEN ${input.validUntil ?? null} ELSE valid_until END,
      description     = CASE WHEN ${input.descriptionProvided}
                            THEN ${input.description ?? null} ELSE description END,
      terms          = CASE WHEN ${input.termsProvided}
                            THEN ${input.terms ?? null} ELSE terms END,
      comment        = COALESCE(${input.comment ?? null}, comment),
      translations   = CASE WHEN ${input.translationsProvided}
                            THEN ${sql.json((input.translations ?? {}) as Record<string, never>)}
                            ELSE translations END,
      updated_at     = now()
    WHERE id = ${input.id}
    RETURNING id, code, name, description, terms, initial_amount, spent_total,
              currency, status, valid_until, translations, comment, created_at, updated_at
  `;
  return mapGiftCertificate(rows[0]!);
}

/** Собирает набор gift-actions поверх инъецированных зависимостей. */
export function createGiftActions(deps: GiftActionDeps) {
  const { actionDeps } = deps;

  async function assertOrdersEnabled(): Promise<void> {
    if (!(await deps.isOrdersEnabled())) {
      throw new GiftCertificateError('validation', 'Модуль «Заказы» выключен.');
    }
  }

  /** Выпуск сертификата (gift.write). */
  const issueGiftCertificate = defineAction({
    permission: 'gift.write',
    input: IssueGiftCertificateSchema,
    deps: actionDeps,
    handler: async (data) => {
      await assertOrdersEnabled();

      // Переводы: только whitelist × не-дефолтные языки, база (ru) — в колонках.
      const localeConfig = await deps.getLocaleConfig();
      const tr = resolveTranslationsUpdate(GIFT_TR_FIELDS, data.translations, {}, localeConfig);

      let cert: GiftCertificate;
      try {
        cert = await deps.insertGiftCertificate({
          code: data.code,
          name: data.name ?? '',
          initialAmount: data.initialAmount,
          validUntil: data.validUntil ?? null,
          description: data.description ?? null,
          terms: data.terms ?? null,
          comment: data.comment ?? '',
          translations: tr.value,
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new GiftCertificateError('duplicate_code', 'Сертификат с таким кодом уже существует.');
        }
        throw err;
      }

      return {
        result: { id: cert.id },
        revalidate: [GIFT_LIST_PATH],
        audit: {
          action: 'gift.issue',
          entityType: 'gift_certificate',
          entityId: cert.id,
          after: {
            code: cert.code,
            initialAmount: cert.initialAmount,
            validUntil: cert.validUntil?.toISOString() ?? null,
          },
        },
      };
    },
  });

  /**
   * Обновление сертификата (gift.write). Доменное правило: initialAmount можно
   * менять ТОЛЬКО ВВЕРХ и НЕ НИЖЕ spentTotal (пополнение, не «урезание» — иначе
   * нарушился бы инвариант spent_total <= initial_amount и остаток стал бы < 0).
   */
  const updateGiftCertificate = defineAction({
    permission: 'gift.write',
    input: UpdateGiftCertificateSchema,
    deps: actionDeps,
    handler: async (data) => {
      await assertOrdersEnabled();

      const before = await deps.getGiftCertificateById(data.id);
      if (!before) {
        throw new GiftCertificateError('not_found', 'Сертификат не найден.');
      }

      if (data.initialAmount !== undefined) {
        const nextMinor = toMinor(data.initialAmount);
        const currentMinor = toMinor(before.initialAmount);
        const spentMinor = toMinor(before.spentTotal);
        if (nextMinor < currentMinor) {
          throw new GiftCertificateError(
            'face_below_spent',
            'Номинал можно только увеличивать (пополнение), не уменьшать.',
          );
        }
        if (nextMinor < spentMinor) {
          throw new GiftCertificateError(
            'face_below_spent',
            'Номинал не может быть ниже уже потраченной суммы.',
          );
        }
      }

      const localeConfig = await deps.getLocaleConfig();
      const tr = resolveTranslationsUpdate(
        GIFT_TR_FIELDS,
        data.translations,
        before.translations,
        localeConfig,
      );

      const after = await deps.updateGiftFields({
        id: data.id,
        name: data.name,
        initialAmount: data.initialAmount,
        validUntil: data.validUntil,
        validUntilProvided: data.validUntil !== undefined,
        description: data.description,
        descriptionProvided: data.description !== undefined,
        terms: data.terms,
        termsProvided: data.terms !== undefined,
        comment: data.comment,
        translations: tr.value,
        translationsProvided: tr.provided,
      });

      return {
        result: { id: after.id },
        revalidate: [GIFT_LIST_PATH, giftPath(after.id)],
        audit: {
          action: 'gift.update',
          entityType: 'gift_certificate',
          entityId: after.id,
          before: { initialAmount: before.initialAmount, validUntil: before.validUntil?.toISOString() ?? null },
          after: { initialAmount: after.initialAmount, validUntil: after.validUntil?.toISOString() ?? null },
        },
      };
    },
  });

  /**
   * Смена статуса active↔disabled (деактивация/реактивация). depleted/expired —
   * автоматические, вручную не выставляются. Реактивация исчерпанного/истёкшего
   * сертификата через 'active' допускается (владелец продлевает срок отдельно).
   */
  const setGiftStatus = defineAction({
    permission: 'gift.write',
    input: SetGiftStatusSchema,
    deps: actionDeps,
    handler: async (data) => {
      await assertOrdersEnabled();

      const before = await deps.getGiftCertificateById(data.id);
      if (!before) {
        throw new GiftCertificateError('not_found', 'Сертификат не найден.');
      }
      const updated = await deps.updateGiftStatus(data.id, data.status as GiftCertificateStatus);
      if (!updated) {
        throw new GiftCertificateError('not_found', 'Сертификат не найден.');
      }

      return {
        result: { id: data.id, status: data.status },
        revalidate: [GIFT_LIST_PATH, giftPath(data.id)],
        audit: {
          action: 'gift.status.change',
          entityType: 'gift_certificate',
          entityId: data.id,
          before: { status: before.status },
          after: { status: data.status },
        },
      };
    },
  });

  return { issueGiftCertificate, updateGiftCertificate, setGiftStatus };
}

// Прод-инстанс (тонкие обёртки для form-actions).
const prodActions = createGiftActions(productionGiftDeps());
export const issueGiftCertificate = prodActions.issueGiftCertificate;
export const updateGiftCertificate = prodActions.updateGiftCertificate;
export const setGiftStatus = prodActions.setGiftStatus;

// PublicActionError реэкспорт для форм (единый тип отображаемых ошибок).
export { PublicActionError };
