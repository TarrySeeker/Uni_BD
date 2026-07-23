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

/**
 * Источник выпуска (колонка issue_source, CHECK в 0054 — text, НЕ enum):
 *  - manual — заведён руками в админке;
 *  - order  — выпущен по позиции заказа (кнопка в карточке заказа);
 *  - auto   — выпущен автоматически (волна 4, вебхук оплаты).
 * null — выпущен до появления поля (исторические строки).
 */
export type GiftIssueSource = 'manual' | 'order' | 'auto';

/**
 * Настройки раздела «Подарочные сертификаты» (ключ настроек 'gift').
 *
 * 🔴 ТИП И ДЕФОЛТЫ ЖИВУТ В РЕЕСТРЕ НАСТРОЕК lib/settings/schemas — здесь только
 * реэкспорт. Своей копии домен не держит осознанно: пока копий было две, форма
 * в админке после «Сбросить настройки сертификатов» рисовала автовыпуск
 * включённым, а фактически выдача денег на предъявителя была выключена.
 *
 *  - autoIssue                — главный рубильник автовыпуска (дефолт платформы —
 *    включён, тем же значением ключ сеет миграция 0056);
 *  - validDays                — срок действия кода в днях от ОПЛАТЫ; 0/пусто/null = бессрочно;
 *  - categorySlugs            — разделы каталога, товары которых при ОФОРМЛЕНИИ
 *    получают маркер сертификата в снимок позиции (lib/orders/repository →
 *    applyGiftCategoryMarker); сам выпуск решает по маркеру — см. isGiftItemForAutoIssue;
 *  - allowIssueOnGiftPaidOrder — разрешить выпуск по заказу, который сам оплачен
 *    сертификатом (иначе баланс переливается сам в себя).
 *
 * Дефолты — GIFT_SETTINGS_DEFAULTS, наложение оверрайда — resolveGiftSettings
 * (обе из lib/settings/schemas; их же читает форма админки).
 */
export type { GiftSettings, ResolvedGiftSettings } from '@/lib/settings/schemas';

/** Все допустимые источники выпуска (совпадает с CHECK миграции 0054). */
export const GIFT_ISSUE_SOURCES: readonly GiftIssueSource[] = ['manual', 'order', 'auto'];

/**
 * Снимок стороны сделки (покупатель/получатель) — ТЕКСТ, а не ссылка (ADR-010):
 * покупатель может быть гостем без аккаунта, а получатель вообще не клиент
 * магазина; правка карточки клиента не должна менять уже выпущенный документ.
 */
export interface GiftParty {
  name: string | null;
  email: string | null;
  phone: string | null;
}

/** Пустой снимок стороны (все поля не заданы). */
export const EMPTY_GIFT_PARTY: GiftParty = { name: null, email: null, phone: null };

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

  // ---- Стороны сделки (ТЗ п.7; миграция 0054) ----
  /** «Кто купил» — снимок на момент выпуска. */
  purchaser: GiftParty;
  /** Опциональная связь покупателя с учёткой клиента (навигация); гость → null. */
  purchaserCustomerId: string | null;
  /** «На чьё имя» — снимок получателя. */
  recipient: GiftParty;

  // ---- Происхождение выпуска (0054) ----
  /**
   * Заказ, ПО КОТОРОМУ сертификат выпущен (продажа сертификата).
   * ⚠️ Не путать с orders.gift_certificate_id — там обратный смысл: заказ, НА
   * который сертификат потрачен.
   */
  issuedOrderId: string | null;
  /** Позиция заказа-источника: из её ценового снимка взят номинал. */
  issuedOrderItemId: string | null;
  /** Способ выпуска; null — историческая строка до 0054. */
  issueSource: GiftIssueSource | null;

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
