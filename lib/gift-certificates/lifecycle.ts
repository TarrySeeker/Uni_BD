/**
 * ЖИЗНЕННЫЙ ЦИКЛ подарочного сертификата — чистые правила смены статуса
 * (аудит: находка №10 «пополнение исчерпанного» и минор №3 «статус expired
 * никогда не выставлялся»).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ. Правил перехода статуса в системе три источника: SQL
 * (redeemGiftTx ставит 'depleted', releaseGiftTx снимает его), админка
 * (setGiftStatus: active↔disabled) и теперь пополнение/истечение. Пока правило
 * «когда код снова работает» жило только внутри SQL, пополнение исчерпанного
 * сертификата поднимало номинал, но НЕ возвращало код в работу: остаток > 0,
 * а assertRedeemable отбивал по статусу ещё до расчёта остатка — деньги на
 * карточке были, воспользоваться ими было нельзя, и кнопки «оживить» тоже не
 * было (UI рисует «Активировать» только для 'disabled').
 *
 * Без БД и без Next: те же функции читает и админка, и крон.
 */

import { toMinor } from '@/lib/orders/money';

import type { GiftCertificateStatus } from './types';

// -----------------------------------------------------------------------------
// Находка №10 — возврат исчерпанного сертификата в работу после пополнения.
// -----------------------------------------------------------------------------

/** Минимум для решения «оживает ли код после пополнения». */
export interface ReviveInput {
  status: GiftCertificateStatus;
  /** Номинал ПОСЛЕ пополнения (NUMERIC-строка). */
  initialAmount: string;
  /** Уже потрачено (NUMERIC-строка). */
  spentTotal: string;
}

/**
 * Статус, который должен получить сертификат после ПОПОЛНЕНИЯ номинала.
 *
 * Оживает ТОЛЬКО 'depleted' и только когда остаток реально стал положительным —
 * ровно то же правило, что у возврата средств (releaseGiftTx: 'depleted' →
 * 'active', если spent_total снова ниже номинала). Единый инвариант: статус
 * 'depleted' означает «остаток нулевой» и не может пережить появление остатка.
 *
 * 🔴 'disabled' пополнением НЕ оживает: отключение — осознанное решение
 * оператора (в т.ч. гашение кодов при возврате заказа, revokeIssuedGiftsTx).
 * Иначе пополнение стало бы обходом блокировки.
 * 🔴 'expired' пополнением НЕ оживает: деньги и срок — разные оси. Срок
 * продлевается полем «Действует до», и после продления код снова активен.
 */
export function reviveStatusAfterTopUp(input: ReviveInput): GiftCertificateStatus {
  if (input.status !== 'depleted') return input.status;
  let remaining = 0;
  try {
    remaining = toMinor(input.initialAmount) - toMinor(input.spentTotal);
  } catch {
    // Битые деньги (исторические строки) — статус не трогаем: молча «оживить»
    // код на нечитаемом остатке опаснее, чем оставить как есть.
    return input.status;
  }
  return remaining > 0 ? 'active' : 'depleted';
}

// -----------------------------------------------------------------------------
// Минор №3 — пометка истёкших сертификатов.
// -----------------------------------------------------------------------------

/** Имя крон-задачи пометки истёкших (домен, а не строковый литерал в роуте). */
export const GIFT_EXPIRE_TASK = 'expire-outdated';

/** Минимум для решения «пора ли пометить код истёкшим». */
export interface ExpireInput {
  status: GiftCertificateStatus;
  validUntil: Date | null;
}

/**
 * Новый статус для ИСТЁКШЕГО сертификата либо null, если менять нечего.
 *
 * Дефект был информационным: деньги защищены явными проверками срока
 * (repository.redeemGiftTx и service.assertRedeemable сравнивают valid_until с
 * текущим временем независимо от статуса), но админка показывала истёкший код
 * «Активен», хотя бейдж и локализованная подпись для 'expired' уже существовали.
 *
 * Помечаем 'active' и 'depleted'.
 * 🔴 'disabled' НЕ трогаем: истечение срока не должно снимать блокировку —
 * оператор, снявший «Отключён», обязан увидеть именно своё решение, а не
 * подменённый краном статус.
 * Уже 'expired' → null: крон идемпотентен.
 */
export function expiredGiftStatus(
  input: ExpireInput,
  now: Date = new Date(),
): GiftCertificateStatus | null {
  if (input.status !== 'active' && input.status !== 'depleted') return null;
  if (input.validUntil == null) return null;
  const until = input.validUntil instanceof Date ? input.validUntil : new Date(String(input.validUntil));
  if (Number.isNaN(until.getTime())) return null;
  // Граница «ровно сейчас» — истёк: та же строгость, что в assertRedeemable
  // (validUntil.getTime() <= now.getTime()), иначе статус и деньги разъедутся.
  return until.getTime() <= now.getTime() ? 'expired' : null;
}
