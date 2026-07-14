/**
 * Типы среза «Подарочные сертификаты-баланс» (docs/24 §5).
 *
 * Балансовый инструмент (порт eAdmin b_promocode_sum): номинал (initialAmount)
 * списывается частично по нескольким заказам, хранится остаток. В отличие от
 * promo_codes (правило скидки per-order без переносимого баланса).
 *
 * Деньги — строки NUMERIC(14,2) (точность из postgres.js не теряется); любая
 * арифметика ведётся в целых копейках (lib/gift-certificates/balance + lib/orders/money).
 */

import type { TranslationsMap } from '@/lib/i18n';

/**
 * Жизненный цикл сертификата (колонка status, CHECK в 0039):
 *  - active   — действует, доступен к списанию;
 *  - depleted — остаток исчерпан (spentTotal == initialAmount); ставится автоматически;
 *  - disabled — отключён вручную (деактивация);
 *  - expired  — истёк срок действия (validUntil в прошлом).
 */
export type GiftCertificateStatus = 'active' | 'depleted' | 'disabled' | 'expired';

/** Все допустимые статусы (для Zod-enum и валидаций). */
export const GIFT_CERTIFICATE_STATUSES: readonly GiftCertificateStatus[] = [
  'active',
  'depleted',
  'disabled',
  'expired',
];

/** Подарочный сертификат (домен). remaining вычисляется маппером (initialAmount − spentTotal). */
export interface GiftCertificate {
  id: string;
  /** Код сертификата (citext, регистронезависим). НЕ переводимо. */
  code: string;
  /** Админ-метка. НЕ переводимо. */
  name: string;
  /** Публичное описание (переводимо, i18n-whitelist). База = язык по умолчанию. */
  description: string | null;
  /** Условия использования (переводимо, i18n-whitelist). */
  terms: string | null;
  /** Номинал (NUMERIC(14,2), > 0). */
  initialAmount: string;
  /** Потрачено (NUMERIC(14,2), 0..initialAmount). */
  spentTotal: string;
  /** Остаток = initialAmount − spentTotal (вычисляется, не хранится). */
  remaining: string;
  currency: string;
  status: GiftCertificateStatus;
  /** Срок действия; null = бессрочно. */
  validUntil: Date | null;
  /** Сырой i18n-оверлей (locale-агностично; резолв — на границе). */
  translations: TranslationsMap;
  comment: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Факт списания части номинала на заказ (леджер 0040). */
export interface GiftCertificateRedemption {
  id: string;
  certificateId: string;
  orderId: string;
  /** Списано на этот заказ (NUMERIC(14,2), > 0). */
  amount: string;
  /** Заполняется при рефанде (возврат баланса); null = активное списание. */
  reversedAt: Date | null;
  createdAt: Date;
}
