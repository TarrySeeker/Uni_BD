/**
 * Чистое ядро «сертификат, выпущенный по заказу» (ТЗ владельца п.7, миграция 0054).
 *
 * Без БД и без Next — только детерминированные функции над СНИМКОМ позиции
 * заказа (order_items, ADR-010). Снимок выбран источником правды осознанно:
 * каталог живёт своей жизнью (цена меняется, категории переименовывают, ETL
 * пересобирает связи), а история заказа неизменна.
 */
import { fromMinor, toMinor, type MoneyString } from '@/lib/orders/money';

import { EMPTY_GIFT_PARTY, type GiftParty } from './types';

/** Часть позиции заказа, нужная для выпуска сертификата (снимок, не каталог). */
export interface CertificateSourceItem {
  id: string;
  nameSnapshot: string;
  skuSnapshot: string;
  attributesSnapshot: Record<string, unknown>;
  unitPrice: MoneyString;
  quantity: number;
  lineTotal: MoneyString;
}

// -----------------------------------------------------------------------------
// Номинал.
// -----------------------------------------------------------------------------

/**
 * Номинал выпускаемого кода = ФАКТИЧЕСКИ УПЛАЧЕННАЯ сумма позиции (line_total из
 * снимка), а не текущая цена товара в каталоге: покупатель заплатил столько,
 * сертификат обязан стоить столько же, даже если завтра цена изменится.
 *
 * quantity > 1: на позицию приходится ОДИН код на всю уплаченную сумму — этого
 * требует частичный UNIQUE (issued_order_item_id) из 0054, который защищает
 * автовыпуск волны 4 от дублей при повторных вебхуках. Владельцу, которому нужны
 * N отдельных кодов, витрина оформляет N позиций.
 *
 * lineTotal битый/пустой (исторические данные) → пересчёт unitPrice × quantity.
 */
export function giftFaceValueFromItem(item: CertificateSourceItem): MoneyString {
  let minor: number | null = null;
  try {
    minor = toMinor(item.lineTotal);
  } catch {
    minor = null;
  }
  if (minor == null || !Number.isFinite(minor)) {
    minor = toMinor(item.unitPrice) * Math.max(0, Math.trunc(item.quantity));
  }
  return fromMinor(Math.max(0, minor));
}

// -----------------------------------------------------------------------------
// «Позиция — сертификат?»
// -----------------------------------------------------------------------------

/**
 * Ключи-маркеры в attributes_snapshot позиции. ПОЧЕМУ так, а не «товар в
 * категории slug='certificates'»: категория — изменяемая сущность текущего
 * каталога (переименуют slug, ETL пересоберёт дерево, в другом магазине раздел
 * называется иначе) — признак «это был сертификат» тогда исчезнет задним числом.
 * Снимок позиции неизменен по ADR-010 и не зависит от ниши магазина: любой
 * магазин платформы кладёт в атрибуты товара-сертификата один из этих ключей.
 * Новых колонок это не требует (attributes_snapshot уже существует).
 */
export const GIFT_ITEM_MARKER_KEYS = [
  'gift_certificate',
  'is_gift_certificate',
  'certificate',
] as const;

/** Значения маркера, трактуемые как «да» (атрибуты приходят из ETL как угодно). */
const TRUTHY = new Set(['true', '1', 'yes', 'y', 'да', 'on']);

function isTruthyMarker(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v > 0;
  if (typeof v === 'string') return TRUTHY.has(v.trim().toLowerCase());
  return false;
}

/**
 * Языковые подсказки по имени-снимку — ВТОРИЧНЫЙ признак (для магазинов, где
 * маркер в атрибуты ещё не проставлен). Никогда не является запретом: кнопка
 * выпуска доступна для любой позиции, подсказка лишь подсвечивает вероятную.
 */
const NAME_HINTS = ['сертификат', 'certificate', 'gift card', 'giftcard'];

/** Насколько уверенно позиция выглядит сертификатом: маркер > имя > нет. */
export function certificateItemHint(item: CertificateSourceItem): 'marked' | 'name' | 'none' {
  const attrs = item.attributesSnapshot ?? {};
  for (const key of GIFT_ITEM_MARKER_KEYS) {
    if (isTruthyMarker(attrs[key])) return 'marked';
  }
  const name = String(item.nameSnapshot ?? '').toLowerCase();
  if (NAME_HINTS.some((h) => name.includes(h))) return 'name';
  return 'none';
}

/** Позиция похожа на сертификат (подсказка UI; выпуск не ограничивает). */
export function looksLikeCertificateItem(item: CertificateSourceItem): boolean {
  return certificateItemHint(item) !== 'none';
}

// -----------------------------------------------------------------------------
// Снимки сторон сделки.
// -----------------------------------------------------------------------------

/** Ввод стороны сделки (частичный, из формы/заказа). */
export interface GiftPartyInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

function trimOrNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

/** Нормализует снимок стороны: обрезка пробелов, пустое → null. */
export function normalizeGiftParty(input: GiftPartyInput | null | undefined): GiftParty {
  if (!input) return { ...EMPTY_GIFT_PARTY };
  return {
    name: trimOrNull(input.name),
    email: trimOrNull(input.email),
    phone: trimOrNull(input.phone),
  };
}

/** Снимок пуст (ни имени, ни email, ни телефона). */
export function isGiftPartyEmpty(party: GiftParty): boolean {
  return party.name == null && party.email == null && party.phone == null;
}

// -----------------------------------------------------------------------------
// Код сертификата, выпускаемого по позиции заказа.
// -----------------------------------------------------------------------------

/**
 * Детерминированный код по заказу и позиции: «НОМЕР-ЗАКАЗА-XXXXXX». Повторный
 * выпуск по той же позиции даст тот же код → упрётся и в UNIQUE(code), и в
 * частичный UNIQUE(issued_order_item_id) — двойного кода не возникнет ни при
 * дребезге кнопки, ни при повторном вебхуке оплаты (волна 4).
 */
export function buildGiftCodeForOrderItem(input: {
  orderNumber: string;
  orderItemId: string;
}): string {
  const base = String(input.orderNumber)
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = String(input.orderItemId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
  return `${base}-${suffix}`.slice(0, 64);
}
