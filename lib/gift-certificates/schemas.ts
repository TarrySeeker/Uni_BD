/**
 * Zod-схемы ввода среза «Подарочные сертификаты» (docs/24 §5).
 *
 * Выпуск/обновление — из админки (gift.write). Денежные суммы — строки NUMERIC
 * (moneySchema из lib/orders), номинал строго > 0 (нулевой сертификат бессмыслен).
 * Переводы description/terms — блок translations, тонкая фильтрация whitelist ×
 * включённые языки делается на сервере (resolveTranslationsUpdate из lib/i18n).
 */
import { z } from 'zod';

import { moneySchema } from '@/lib/orders/schemas';
import { toMinor } from '@/lib/orders/money';
import { translationsBlockSchema } from '@/lib/i18n';

import { GIFT_CERTIFICATE_STATUSES } from './types';

/** Код сертификата (citext в БД): непустой, без пробелов по краям, до 64 символов. */
export const giftCodeSchema = z.string().trim().min(1).max(64);

/**
 * Номинал: денежная строка строго > 0 (нулевой/отрицательный номинал запрещён).
 * toMinor обёрнут в try/catch — moneySchema.regex и refine выполняются
 * независимо (Zod собирает все issue), поэтому на входе с >2 знаками refine
 * получил бы строку, на которой toMinor бросает; безопасно трактуем как невалид.
 */
export const giftFaceValueSchema = moneySchema.refine(
  (v) => {
    try {
      return toMinor(v) > 0;
    } catch {
      return false;
    }
  },
  { message: 'Номинал сертификата должен быть больше нуля.' },
);

/** Срок действия: ISO-строка → Date, либо null (бессрочно), либо отсутствует. */
const validUntilSchema = z
  .union([z.string().datetime({ offset: true }), z.date()])
  .transform((v) => (v instanceof Date ? v : new Date(v)))
  .nullable()
  .optional();

/** Выпуск сертификата (gift.write). */
export const IssueGiftCertificateSchema = z.object({
  code: giftCodeSchema,
  name: z.string().trim().max(255).optional().default(''),
  initialAmount: giftFaceValueSchema,
  validUntil: validUntilSchema,
  description: z.string().trim().max(20000).nullable().optional(),
  terms: z.string().trim().max(20000).nullable().optional(),
  comment: z.string().trim().max(2000).optional().default(''),
  translations: translationsBlockSchema,
});
export type IssueGiftCertificateInput = z.infer<typeof IssueGiftCertificateSchema>;

/**
 * Обновление сертификата (gift.write). Все контентные/срочные поля — опционально
 * (partial). initialAmount разрешено менять ТОЛЬКО ВВЕРХ и не ниже spentTotal —
 * это доменное правило проверяется в action против текущей строки (Zod границу
 * «не ниже spent» не знает без чтения БД).
 */
export const UpdateGiftCertificateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().max(255).optional(),
  initialAmount: giftFaceValueSchema.optional(),
  validUntil: validUntilSchema,
  description: z.string().trim().max(20000).nullable().optional(),
  terms: z.string().trim().max(20000).nullable().optional(),
  comment: z.string().trim().max(2000).optional(),
  translations: translationsBlockSchema,
});
export type UpdateGiftCertificateInput = z.infer<typeof UpdateGiftCertificateSchema>;

/** Деактивация/реактивация сертификата (gift.write). */
export const SetGiftStatusSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['active', 'disabled'] as [string, ...string[]]),
});
export type SetGiftStatusInput = z.infer<typeof SetGiftStatusSchema>;

/** Применение кода сертификата в корзине/заказе (задел под 4b — quote/create). */
export const applyGiftCodeSchema = giftCodeSchema;

/** Все статусы — реэкспорт для UI/валидаций. */
export const giftStatuses = GIFT_CERTIFICATE_STATUSES;
