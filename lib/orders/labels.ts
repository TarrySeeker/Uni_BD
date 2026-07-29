/**
 * Канонические подписи статусов заказа/оплаты/доставки (G-15) — ru/en/fr.
 *
 * ЕДИНЫЙ источник истины: использует и админка (lib/admin/order-format реэкспортит),
 * и публичный DTO заказа (lib/storefront/order-dto добавляет *Label в ответ витрине).
 * Раньше витрина держала свою карту подписей и расходилась с админкой
 * (shipped: «Отправлен» vs «Отгружен» — аудит docs/18, G-15). Теперь подпись одна.
 *
 * 🔴 ИСТОЧНИК НЕ РАСЩЕПЛЯЕТСЯ (аудит major №5/№28/№30/№35, minor №6). Раньше карты
 * были ЖЁСТКО РУССКИМИ и локаль игнорировалась обоими потребителями. Лечение —
 * не вторая карта под витрину (это вернуло бы G-15), а КОЛОНКИ по локалям в той
 * же таблице: строка = статус, колонка = язык. Подписи для покупателя и оператора
 * физически берутся из одних и тех же ячеек.
 *
 * ДВА НЕЗАВИСИМЫХ ЯЗЫКА У ПОТРЕБИТЕЛЕЙ:
 *   • ПОКУПАТЕЛЬ (витрина) — язык из URL-префикса, приезжает в Storefront API как
 *     `?locale=`; сервер отдаёт ГОТОВЫЙ ТЕКСТ в поле *Label (контракт живой
 *     витрины erfgv.website ломать нельзя — поле обязано остаться текстом);
 *   • ОПЕРАТОР (админка) — язык из cookie NEXT_LOCALE (next-intl), к языку
 *     покупателя отношения не имеет. Админка берёт не текст, а КЛЮЧ каталога
 *     (*StatusLabelKey) и резолвит его через t() у себя.
 * Оператор может смотреть fr, покупатель — en; оба увидят свой язык.
 *
 * АДДИТИВНОСТЬ: параметр локали НЕобязателен. Старый вызов без него возвращает те
 * же русские строки, что и до правки (ru — базовая локаль магазина).
 *
 * Record по литералам типов → исчерпывающая проверка компилятором; незнакомый код
 * безопасно возвращается как есть (фолбэк).
 */
import type { OrderStatus, PaymentStatus, DeliveryStatus } from '@/lib/orders/types';

/** Локали, для которых есть подписи статусов. Порядок: базовая первой. */
export const STATUS_LABEL_LOCALES = ['ru', 'en', 'fr'] as const;

/** Локаль подписи статуса. */
export type StatusLabelLocale = (typeof STATUS_LABEL_LOCALES)[number];

/** Базовая локаль магазина — фолбэк для незнакомого языка. */
const BASE_LOCALE: StatusLabelLocale = 'ru';

/** Подписи одного статуса на всех языках платформы. */
type LocalizedLabel = Record<StatusLabelLocale, string>;

const ORDER_STATUS_LABELS: Record<OrderStatus, LocalizedLabel> = {
  new: { ru: 'Новый', en: 'New', fr: 'Nouvelle' },
  awaiting_payment: {
    ru: 'Ожидает оплаты',
    en: 'Awaiting payment',
    fr: 'En attente de paiement',
  },
  paid: { ru: 'Оплачен', en: 'Paid', fr: 'Payée' },
  packed: { ru: 'Собран', en: 'Packed', fr: 'Préparée' },
  shipped: { ru: 'Отгружен', en: 'Shipped', fr: 'Expédiée' },
  delivered: { ru: 'Доставлен', en: 'Delivered', fr: 'Livrée' },
  completed: { ru: 'Завершён', en: 'Completed', fr: 'Terminée' },
  cancelled: { ru: 'Отменён', en: 'Cancelled', fr: 'Annulée' },
  refunded: { ru: 'Возврат', en: 'Refunded', fr: 'Remboursée' },
};

const PAYMENT_STATUS_LABELS: Record<PaymentStatus, LocalizedLabel> = {
  pending: { ru: 'Ожидает', en: 'Pending', fr: 'En attente' },
  authorized: { ru: 'Авторизована', en: 'Authorised', fr: 'Autorisé' },
  paid: { ru: 'Оплачена', en: 'Paid', fr: 'Payé' },
  failed: { ru: 'Ошибка', en: 'Failed', fr: 'Échoué' },
  refunded: { ru: 'Возврат', en: 'Refunded', fr: 'Remboursé' },
};

const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, LocalizedLabel> = {
  pending: { ru: 'Ожидает', en: 'Pending', fr: 'En attente' },
  registered: { ru: 'Зарегистрирована', en: 'Registered', fr: 'Enregistrée' },
  in_transit: { ru: 'В пути', en: 'In transit', fr: 'En cours de livraison' },
  delivered: { ru: 'Доставлена', en: 'Delivered', fr: 'Livrée' },
  returned: { ru: 'Возврат', en: 'Returned', fr: 'Retournée' },
  cancelled: { ru: 'Отменена', en: 'Cancelled', fr: 'Annulée' },
};

/** Русская колонка отдельной картой — легаси-форма, её импортируют потребители. */
function ruColumn<T extends string>(
  src: Record<T, LocalizedLabel>,
): Record<T, string> {
  const out = {} as Record<T, string>;
  for (const code of Object.keys(src) as T[]) out[code] = src[code][BASE_LOCALE];
  return out;
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> =
  ruColumn(ORDER_STATUS_LABELS);
export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> =
  ruColumn(PAYMENT_STATUS_LABELS);
export const DELIVERY_STATUS_LABEL: Record<DeliveryStatus, string> =
  ruColumn(DELIVERY_STATUS_LABELS);

/**
 * Приводит произвольный тег языка к колонке подписей: регистр и региональный
 * суффикс игнорируются ('EN', 'en-US' → 'en'). Незнакомый язык → базовая локаль:
 * магазин может включить 4-й язык раньше, чем появится колонка, и покупателю
 * лучше осмысленная русская строка, чем машинный код.
 */
function resolveLocale(locale: string | null | undefined): StatusLabelLocale {
  if (!locale) return BASE_LOCALE;
  const tag = locale.trim().toLowerCase().split(/[-_]/)[0];
  return (STATUS_LABEL_LOCALES as readonly string[]).includes(tag)
    ? (tag as StatusLabelLocale)
    : BASE_LOCALE;
}

/** Безопасный поиск подписи: незнакомый код → сам код (фолбэк, без падения). */
function label<T extends string>(
  map: Record<T, LocalizedLabel>,
  code: string,
  locale: string | null | undefined,
): string {
  const row = (map as Record<string, LocalizedLabel | undefined>)[code];
  return row ? row[resolveLocale(locale)] : code;
}

export function orderStatusLabel(status: string, locale?: string | null): string {
  return label(ORDER_STATUS_LABELS, status, locale);
}
export function paymentStatusLabel(status: string, locale?: string | null): string {
  return label(PAYMENT_STATUS_LABELS, status, locale);
}
export function deliveryStatusLabel(status: string, locale?: string | null): string {
  return label(DELIVERY_STATUS_LABELS, status, locale);
}

// ---------------------------------------------------------------------------
// Ключи каталога интерфейса АДМИНКИ (next-intl).
//
// Оператору отдаём КЛЮЧ, а не текст: подпись обязана следовать локали оператора
// (cookie NEXT_LOCALE), а этот модуль о ней ничего не знает. Тот же приём, что у
// статусов покупателей (customerStatusLabelKey). Тексты ключей в messages/*.json
// синхронны таблицам выше — гард tests/admin/order-status-labels-i18n.guard.
// ---------------------------------------------------------------------------

/** Ключ каталога или null, если код домену неизвестен (перевода не выдумываем). */
function labelKey<T extends string>(
  map: Record<T, LocalizedLabel>,
  group: string,
  code: string,
): string | null {
  return Object.hasOwn(map, code) ? `orders.statusLabels.${group}.${code}` : null;
}

export function orderStatusLabelKey(status: string): string | null {
  return labelKey(ORDER_STATUS_LABELS, 'order', status);
}
export function paymentStatusLabelKey(status: string): string | null {
  return labelKey(PAYMENT_STATUS_LABELS, 'payment', status);
}
export function deliveryStatusLabelKey(status: string): string | null {
  return labelKey(DELIVERY_STATUS_LABELS, 'delivery', status);
}
