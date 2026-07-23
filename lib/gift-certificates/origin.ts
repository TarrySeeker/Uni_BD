/**
 * Чистое ядро «сертификат, выпущенный по заказу» (ТЗ владельца п.7, миграция 0054).
 *
 * Без БД и без Next — только детерминированные функции над СНИМКОМ позиции
 * заказа (order_items, ADR-010). Снимок выбран источником правды осознанно:
 * каталог живёт своей жизнью (цена меняется, категории переименовывают, ETL
 * пересобирает связи), а история заказа неизменна.
 */
import { randomBytes } from 'node:crypto';

import { fromMinor, toMinor, type MoneyString } from '@/lib/orders/money';

import { EMPTY_GIFT_PARTY, type GiftParty, type GiftSettings } from './types';

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
 * Детерминированный код по заказу и позиции: «НОМЕР-ЗАКАЗА-XXXXXX».
 *
 * 🔴 ТОЛЬКО РУЧНОЙ ВЫПУСК (кнопка в админке, где код виден админу и его удобно
 * сопоставить с заказом). В АВТОВЫПУСКЕ ЗАПРЕЩЁН: код детерминирован из номера
 * заказа (последовательного) и 6 hex-символов ≈ 24 бита, а POST
 * /api/storefront/v1/cart/quote — публичный оракул, отвечающий applied/not_found.
 * Такой код перебирается. Автопуть обязан звать randomGiftCode (~80 бит).
 *
 * ⚠️ Идемпотентность выпуска БОЛЬШЕ НЕ ОПИРАЕТСЯ на детерминированность кода:
 * единственная защита от дублей — ЧАСТИЧНЫЙ UNIQUE (issued_order_item_id) из
 * миграции 0054. Случайный код повторным вебхуком не «схлопнется» сам по себе —
 * второй INSERT ловит 23505 по позиции заказа и трактуется как no-op.
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

/**
 * Алфавит Crockford base32: без I, L, O, U — символы, которые путают при диктовке
 * по телефону и при переписывании с бумажного сертификата (0/O, 1/I/L), а U убран
 * автором стандарта, чтобы код случайно не сложился в бранное слово.
 */
export const GIFT_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Байт энтропии на код: 10 байт = 80 бит = ровно 16 символов base32. */
const GIFT_CODE_BYTES = 10;

/**
 * КРИПТОСЛУЧАЙНЫЙ код на предъявителя: 16 символов Crockford base32 (~80 бит),
 * сгруппированные как XXXX-XXXX-XXXX-XXXX.
 *
 * ПОЧЕМУ не детерминированный код (buildGiftCodeForOrderItem): он даёт ~24 бита и
 * привязан к последовательному номеру заказа, а публичный quote-эндпоинт отвечает
 * «код применён / не найден» — то есть работает оракулом для перебора. 80 бит
 * делают перебор бессмысленным при любой скорости запросов.
 *
 * `bytes` инъецируется только тестами; в проде — CSPRNG (node:crypto).
 */
export function randomGiftCode(bytes: Uint8Array = randomBytes(GIFT_CODE_BYTES)): string {
  let acc = 0;
  let bits = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += GIFT_CODE_ALPHABET[(acc >> bits) & 31];
      acc &= (1 << bits) - 1;
    }
  }
  return (out.match(/.{1,4}/g) ?? [out]).join('-');
}

// -----------------------------------------------------------------------------
// Автовыпуск: резолвер позиции и срок действия.
// (Разбор самих настроек — в реестре: lib/settings/schemas → resolveGiftSettings.)
// -----------------------------------------------------------------------------

/**
 * Позиция подлежит АВТОМАТИЧЕСКОМУ выпуску сертификата.
 *
 * 🔴 Решает ТОЛЬКО маркер в снимке атрибутов. Совпадение по ИМЕНИ (подсказка
 * certificateItemHint → 'name') намеренно НЕ выпускает: «сертификат подлинности»,
 * «подарочная упаковка», «gift box» в названии превратились бы в бесплатные деньги
 * на предъявителя. Имя остаётся подсказкой для админки и ручной кнопки, где
 * решение принимает человек.
 *
 * Настройки участвуют лишь как рубильник: autoIssue === false выключает автопуть
 * целиком. categorySlugs здесь НЕ проверяется и проверяться не может: разделы
 * влияют раньше — при ОФОРМЛЕНИИ заказа товар из такого раздела получает маркер
 * в снимок позиции (lib/orders/repository → applyGiftCategoryMarker). Категория
 * товара изменяема, снимок позиции — нет (ADR-010), поэтому решает снимок.
 */
export function isGiftItemForAutoIssue(item: CertificateSourceItem, settings?: GiftSettings): boolean {
  if (settings?.autoIssue === false) return false;
  return certificateItemHint(item) === 'marked';
}

/** Ключи снимка, задающие срок действия кода в днях для конкретной позиции. */
export const GIFT_VALID_DAYS_KEYS = [
  'gift_valid_days',
  'certificate_valid_days',
  'gift_certificate_valid_days',
] as const;

/** Число из атрибута ETL (число или строка); не число → null. */
function parseDays(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  }
  return null;
}

/**
 * Срок действия кода в днях: снимок позиции > настройка магазина > null.
 * 0 и отрицательное = «бессрочно» (null), причём явный 0 в снимке ПЕРЕБИВАЕТ
 * настройку магазина — товар «бессрочный сертификат» так и задаётся.
 */
export function giftValidDaysFor(item: CertificateSourceItem, settings?: GiftSettings): number | null {
  const attrs = item.attributesSnapshot ?? {};
  for (const key of GIFT_VALID_DAYS_KEYS) {
    const days = parseDays(attrs[key]);
    if (days != null) return days > 0 ? days : null;
  }
  const fromSettings = parseDays(settings?.validDays ?? null);
  if (fromSettings != null) return fromSettings > 0 ? fromSettings : null;
  return null;
}

/**
 * Дата окончания действия кода.
 *
 * 🔴 Отсчёт СТРОГО от paidAt (orders.paid_at), не от now() и не от created_at:
 *  - заказ, пролежавший месяц неоплаченным, иначе породил бы почти истёкший код;
 *  - крон-догоняльщик (найденные пропущенные заказы) выдал бы РАЗНЫЙ срок в
 *    зависимости от того, когда он проснулся, — один и тот же заказ дважды.
 * paidAt отсутствует (историческая строка) → бессрочно: лучше без срока, чем
 * с датой, посчитанной не от того события.
 */
export function giftValidUntil(paidAt: Date | null | undefined, days: number | null): Date | null {
  if (days == null || days <= 0) return null;
  if (!paidAt) return null;
  const base = paidAt instanceof Date ? paidAt : new Date(String(paidAt));
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}
