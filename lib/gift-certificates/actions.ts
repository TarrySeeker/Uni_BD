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
  IssueGiftFromOrderSchema,
} from './schemas';
import {
  insertGiftCertificate,
  getGiftCertificateById,
  getOrderItemForGiftIssue,
  updateGiftStatus,
  mapGiftCertificate,
  giftColumnsFragment,
  type IssueGiftCertificateRow,
  type GiftIssueSourceRow,
} from './repository';
import {
  giftFaceValueFromItem,
  giftValidDaysFor,
  giftValidUntil,
  normalizeGiftParty,
  randomGiftCode,
  type GiftPartyInput,
} from './origin';
import { reviveStatusAfterTopUp } from './lifecycle';
import { getSetting } from '@/lib/settings/repository';
import { resolveGiftSettings, type ResolvedGiftSettings } from '@/lib/settings/schemas';
import { sql } from '@/lib/db/client';
import type { GiftCertificate, GiftCertificateStatus, GiftParty } from './types';

/** Ключ настроек магазина с политикой сертификатов (тот же, что у автовыпуска). */
const GIFT_SETTINGS_KEY = 'gift';

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
  /** Заказ + позиция-снимок для выпуска «по заказу» (ТЗ п.7). */
  getOrderItemForGiftIssue: (orderId: string, orderItemId: string) => Promise<GiftIssueSourceRow | null>;
  /**
   * Политика сертификатов магазина (ТА ЖЕ, что у автовыпуска). Ручной путь обязан
   * знать её: до находки №27 он игнорировал и калитки заказа, и срок действия.
   */
  getGiftSettings: () => Promise<ResolvedGiftSettings>;
  /**
   * Генератор кода на предъявителя. 🔴 ТОЛЬКО криптостойкий (находка №13):
   * детерминированный код из номера заказа даёт ~24 бита и перебирается через
   * публичный /cart/quote, который отвечает applied/not_found.
   */
  randomCode: () => string;
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
  /** Снимок «кто купил»; пишется только когда блок пришёл в форме. */
  purchaser?: GiftParty;
  purchaserProvided: boolean;
  /** Снимок «на чьё имя». */
  recipient?: GiftParty;
  recipientProvided: boolean;
  /**
   * Статус, в который надо вернуть ИСЧЕРПАННЫЙ сертификат после пополнения
   * (находка №10). null — статус не трогаем. Считается чистым правилом
   * reviveStatusAfterTopUp, а применяется в UPDATE атомарно вместе с номиналом:
   * отдельным запросом между ними существовало бы окно «остаток есть, а код
   * мёртв».
   */
  reviveStatus: GiftCertificateStatus | null;
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
    getOrderItemForGiftIssue,
    getGiftSettings: async () => resolveGiftSettings((await getSetting(GIFT_SETTINGS_KEY))?.value),
    randomCode: randomGiftCode,
  };
}

/**
 * UPDATE полей сертификата (partial). Только переданные ключи трогаются
 * (CASE WHEN provided). translations пишется одним UPDATE вместе с базой (ru).
 *
 * Находка №10: статус оживает В ТОМ ЖЕ UPDATE, что и номинал. Условие
 * `status = 'depleted'` повторено в SQL намеренно — между чтением строки в
 * action и этим запросом сертификат могли отключить или погасить возвратом
 * заказа; guard в WHERE-части CASE не даёт пополнению снять чужое решение.
 */
async function updateGiftFieldsDb(input: UpdateFieldsInput): Promise<GiftCertificate> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE gift_certificates SET
      name           = COALESCE(${input.name ?? null}, name),
      initial_amount = COALESCE(${input.initialAmount ?? null}, initial_amount),
      status         = CASE
                         WHEN ${input.reviveStatus ?? null}::text IS NOT NULL
                              AND status = 'depleted'
                              AND COALESCE(${input.initialAmount ?? null}, initial_amount) > spent_total
                           THEN ${input.reviveStatus ?? null}
                         ELSE status
                       END,
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
      purchaser_name  = CASE WHEN ${input.purchaserProvided}
                            THEN ${input.purchaser?.name ?? null} ELSE purchaser_name END,
      purchaser_email = CASE WHEN ${input.purchaserProvided}
                            THEN ${input.purchaser?.email ?? null} ELSE purchaser_email END,
      purchaser_phone = CASE WHEN ${input.purchaserProvided}
                            THEN ${input.purchaser?.phone ?? null} ELSE purchaser_phone END,
      recipient_name  = CASE WHEN ${input.recipientProvided}
                            THEN ${input.recipient?.name ?? null} ELSE recipient_name END,
      recipient_email = CASE WHEN ${input.recipientProvided}
                            THEN ${input.recipient?.email ?? null} ELSE recipient_email END,
      recipient_phone = CASE WHEN ${input.recipientProvided}
                            THEN ${input.recipient?.phone ?? null} ELSE recipient_phone END,
      updated_at     = now()
    WHERE id = ${input.id}
    RETURNING ${giftColumnsFragment()}
  `;
  return mapGiftCertificate(rows[0]!);
}

// -----------------------------------------------------------------------------
// Калитки ручного выпуска (находка аудита №27).
// -----------------------------------------------------------------------------

/**
 * Причина, по которой ручной выпуск по заказу запрещён. Набор НАМЕРЕННО совпадает
 * с автопутём (AutoIssueSkipReason): «выпускать ли код по этому заказу» — один
 * доменный вопрос, и два разных ответа на него уже дали дефект №27 (ручная кнопка
 * выпускала деньги на предъявителя по неоплаченному заказу, пока автопуть
 * добросовестно отказывался).
 */
export type ManualIssueGateReason = 'order_not_paid' | 'order_not_eligible' | 'paid_with_gift';

/** Заголовок заказа в объёме, достаточном для калитки. */
export interface ManualIssueOrderGate {
  paymentStatus: string;
  status: string;
  /** Сертификат, которым оплачен САМ заказ (не путать с issued_order_id). */
  giftCertificateId?: string | null;
}

/** Тексты отказов (доменные, доходят до оператора как сообщение действия). */
const GATE_MESSAGES: Record<ManualIssueGateReason, string> = {
  order_not_paid:
    'Заказ не оплачен: выпустить сертификат с деньгами по неоплаченному заказу нельзя. ' +
    'Если оплата прошла мимо эквайринга, отметьте обход и укажите причину в комментарии.',
  order_not_eligible:
    'Заказ отменён или возвращён: выпускать по нему сертификат нельзя. ' +
    'Если это осознанная компенсация, отметьте обход и укажите причину в комментарии.',
  paid_with_gift:
    'Заказ оплачен другим сертификатом, а настройки магазина запрещают выпуск по таким заказам.',
};

/**
 * Калитка ручного выпуска. Возвращает причину отказа либо null.
 *
 * Порядок и смысл проверок повторяют orderGateReason автопути; дополнительно
 * учитывается политика allowIssueOnGiftPaidOrder (в автопути она проверяется
 * отдельным шагом сразу после калитки — здесь собрано в одном месте, потому что
 * ручной путь единственной точкой решения удобнее и тестируется целиком).
 */
export function manualIssueGateReason(
  order: ManualIssueOrderGate,
  settings: Pick<ResolvedGiftSettings, 'allowIssueOnGiftPaidOrder'>,
): ManualIssueGateReason | null {
  if (order.paymentStatus !== 'paid') return 'order_not_paid';
  if (order.status === 'cancelled' || order.status === 'refunded') return 'order_not_eligible';
  if (order.giftCertificateId && settings.allowIssueOnGiftPaidOrder !== true) {
    return 'paid_with_gift';
  }
  return null;
}

/** Реэкспорт чистого правила оживления (находка №10) — точка входа для UI/тестов. */
export { reviveStatusAfterTopUp };

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
          // Стороны сделки — СНИМКИ (ТЗ п.7): правка карточки клиента их не меняет.
          purchaser: normalizeGiftParty(data.purchaser as GiftPartyInput | undefined),
          recipient: normalizeGiftParty(data.recipient as GiftPartyInput | undefined),
          issueSource: 'manual',
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

      /**
       * Находка №10: пополнение ИСЧЕРПАННОГО сертификата обязано вернуть его в
       * работу. Раньше номинал рос, остаток становился положительным, а status
       * оставался 'depleted' — assertRedeemable отбивал код по статусу ДО
       * расчёта остатка, и «оживить» его было нечем (кнопка «Активировать»
       * рисуется только для 'disabled'). Правило чистое и общее с SQL-путём
       * возврата средств: 'depleted' не переживает появление остатка.
       */
      const reviveStatus =
        data.initialAmount !== undefined
          ? (() => {
              const next = reviveStatusAfterTopUp({
                status: before.status,
                initialAmount: data.initialAmount,
                spentTotal: before.spentTotal,
              });
              return next === before.status ? null : next;
            })()
          : null;

      const after = await deps.updateGiftFields({
        id: data.id,
        reviveStatus,
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
        purchaser: normalizeGiftParty(data.purchaser as GiftPartyInput | undefined),
        purchaserProvided: data.purchaser !== undefined,
        recipient: normalizeGiftParty(data.recipient as GiftPartyInput | undefined),
        recipientProvided: data.recipient !== undefined,
      });

      return {
        result: { id: after.id },
        revalidate: [GIFT_LIST_PATH, giftPath(after.id)],
        audit: {
          action: 'gift.update',
          entityType: 'gift_certificate',
          entityId: after.id,
          // Статус в диффе: пополнение может ОЖИВИТЬ исчерпанный код (находка
          // №10) — владелец обязан видеть это движение денег на предъявителя.
          before: {
            initialAmount: before.initialAmount,
            validUntil: before.validUntil?.toISOString() ?? null,
            status: before.status,
          },
          after: {
            initialAmount: after.initialAmount,
            validUntil: after.validUntil?.toISOString() ?? null,
            status: after.status,
          },
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

  /**
   * Выпуск сертификата ПО ПОЗИЦИИ ЗАКАЗА (gift.write, ТЗ п.7).
   *
   * Номинал — ФАКТИЧЕСКИ УПЛАЧЕННАЯ сумма из ценового снимка позиции
   * (order_items.line_total), а не текущая цена товара: каталог мог подорожать
   * после покупки. Покупатель — из денормализованных полей заказа (гостевой
   * чекаут не даёт customers-строки; customer_id пишем ссылкой, если он есть).
   * Получатель — из формы («на чьё имя»).
   *
   * КАЛИТКИ (находка аудита №27). Раньше единственной проверкой был «номинал > 0»:
   * код с деньгами выпускался по НЕОПЛАЧЕННОМУ, отменённому или возвращённому
   * заказу, а срок действия всегда был бессрочным. Теперь путь проходит ТЕ ЖЕ
   * калитки, что автовыпуск (manualIssueGateReason ≡ orderGateReason + политика
   * «оплачен сертификатом»), и берёт срок из политики магазина.
   *
   * ГРАНИЦА ручного исключения. Полный запрет был бы неверен: оператор обязан
   * уметь выпустить код по заказу, оплаченному мимо эквайринга (наличные в
   * салоне, банковский перевод, компенсация). Поэтому обход возможен, но он
   * ЯВНЫЙ и следовой: требует флага overrideGate, письменного обоснования в
   * comment и попадает в аудит вместе с причиной, которую обошли. Умолчание —
   * безопасное: без флага отказ.
   *
   * Идемпотентность: повторный выпуск по той же позиции упирается в частичный
   * UNIQUE (issued_order_item_id) миграции 0054 → duplicate_issue. Это же
   * ограничение защитит автовыпуск волны 4 при повторных вебхуках оплаты.
   */
  const issueGiftFromOrder = defineAction({
    permission: 'gift.write',
    input: IssueGiftFromOrderSchema,
    deps: actionDeps,
    handler: async (data) => {
      await assertOrdersEnabled();

      const src = await deps.getOrderItemForGiftIssue(data.orderId, data.orderItemId);
      if (!src) {
        throw new GiftCertificateError('not_found', 'Позиция заказа не найдена.');
      }

      const faceValue = giftFaceValueFromItem(src.item);
      if (toMinor(faceValue) <= 0) {
        throw new GiftCertificateError(
          'invalid_amount',
          'По бесплатной позиции сертификат выпустить нельзя: номинал должен быть больше нуля.',
        );
      }

      const settings = await deps.getGiftSettings();

      // Калитка заказа — общая с автопутём (находка №27).
      const gate = manualIssueGateReason(src, settings);
      if (gate) {
        if (data.overrideGate !== true) {
          throw new GiftCertificateError('order_not_eligible', GATE_MESSAGES[gate]);
        }
        // Обход разрешён только «под протокол»: без письменного основания
        // владелец не отличит компенсацию от ошибки оператора.
        if ((data.comment ?? '').trim() === '') {
          throw new GiftCertificateError(
            'validation',
            'Выпуск в обход проверки требует причины: заполните комментарий (основание).',
          );
        }
      }
      const overridden = gate !== null;

      /**
       * 🔴 Находка №13. Код на предъявителя — только CSPRNG (randomGiftCode,
       * ~80 бит). Прежний детерминированный код строился из ПОСЛЕДОВАТЕЛЬНОГО
       * номера заказа + 6 hex ≈ 24 бита, а публичный POST /cart/quote отвечает
       * applied/not_found — то есть работает оракулом перебора. Явный код от
       * оператора уважаем (перенос бумажного бланка), но по умолчанию не
       * выводим код ни из чего предсказуемого.
       */
      const code = data.code ?? deps.randomCode();

      /**
       * Срок действия: явный выбор оператора > снимок позиции > политика
       * магазина. Отсчёт от ОПЛАТЫ (как в автопути) — заказ, пролежавший месяц,
       * иначе породил бы почти истёкший код. Для выпуска в обход калитки
       * (оплаты может не быть вовсе) базой служит момент выпуска.
       */
      const validUntil =
        data.validUntil !== undefined && data.validUntil !== null
          ? data.validUntil
          : giftValidUntil(src.paidAt ?? new Date(), giftValidDaysFor(src.item, settings));

      let cert: GiftCertificate;
      try {
        cert = await deps.insertGiftCertificate({
          code,
          name: data.name ?? src.item.nameSnapshot,
          initialAmount: faceValue,
          validUntil,
          description: null,
          terms: null,
          comment: data.comment ?? '',
          translations: {},
          purchaser: {
            name: src.customerName || null,
            email: src.customerEmail || null,
            phone: src.customerPhone || null,
          },
          purchaserCustomerId: src.customerId,
          recipient: normalizeGiftParty(data.recipient as GiftPartyInput | undefined),
          issuedOrderId: src.orderId,
          issuedOrderItemId: src.item.id,
          issueSource: 'order',
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new GiftCertificateError(
            'duplicate_issue',
            'По этой позиции заказа сертификат уже выпущен.',
          );
        }
        throw err;
      }

      return {
        result: { id: cert.id, code: cert.code, initialAmount: cert.initialAmount },
        revalidate: [GIFT_LIST_PATH, `/admin/orders/${src.orderId}`],
        audit: {
          action: 'gift.issue',
          entityType: 'gift_certificate',
          entityId: cert.id,
          after: {
            code: cert.code,
            initialAmount: cert.initialAmount,
            validUntil: cert.validUntil?.toISOString() ?? null,
            issueSource: 'order',
            issuedOrderId: src.orderId,
            issuedOrderItemId: src.item.id,
            // Обход калитки (находка №27) обязан быть видим владельцу: иначе
            // выпуск по неоплаченному заказу неотличим от обычного.
            ...(overridden
              ? { gateOverridden: true, gateReason: gate, gateJustification: data.comment ?? '' }
              : {}),
          },
        },
      };
    },
  });

  return { issueGiftCertificate, updateGiftCertificate, setGiftStatus, issueGiftFromOrder };
}

// Прод-инстанс (тонкие обёртки для form-actions).
const prodActions = createGiftActions(productionGiftDeps());
export const issueGiftCertificate = prodActions.issueGiftCertificate;
export const updateGiftCertificate = prodActions.updateGiftCertificate;
export const setGiftStatus = prodActions.setGiftStatus;
export const issueGiftFromOrder = prodActions.issueGiftFromOrder;

// PublicActionError реэкспорт для форм (единый тип отображаемых ошибок).
export { PublicActionError };
