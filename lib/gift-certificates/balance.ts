/**
 * Чистое балансовое ядро подарочного сертификата (docs/24 §5) — БЕЗ БД/Next.
 *
 * Семантика eAdmin Cart::promoCodeSumValue: применяемая сумма = min(остаток,
 * сумма к оплате). Остаток = номинал − потрачено. Все деньги считаются в целых
 * КОПЕЙКАХ (lib/orders/money): точность float не теряется, сравнения точны.
 *
 * Функции чистые и тестируемые изолированно (TDD): математика отделена от SQL
 * (репозиторий вызывает эти функции, а декремент выполняет guarded UPDATE).
 */
import { toMinor, fromMinor, type MoneyString } from '@/lib/orders/money';
import type { GiftCertificate, GiftCertificateStatus } from './types';

/**
 * Остаток в копейках = номинал − потрачено. Клампится в [0, +∞): отрицательный
 * остаток невозможен по инварианту БД (spent_total <= initial_amount), но клампим
 * для устойчивости к грязным входам.
 */
export function remainingMinor(initialMinor: number, spentMinor: number): number {
  return Math.max(0, initialMinor - spentMinor);
}

/** Остаток как денежная строка NUMERIC(14,2) из строк номинала/потраченного. */
export function computeRemaining(initial: MoneyString, spent: MoneyString): MoneyString {
  return fromMinor(remainingMinor(toMinor(initial), toMinor(spent)));
}

/**
 * Применяемая сумма (в копейках) = min(max(0,остаток), max(0,кОплате)).
 * Семантика Cart::promoCodeSumValue: сертификат покрывает не больше остатка и не
 * больше суммы к оплате. Отрицательные/битые входы → 0 (клампятся).
 */
export function computeApplicableMinor(remaining: number, amountDueMinor: number): number {
  const rem = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  const due = Number.isFinite(amountDueMinor) ? Math.max(0, amountDueMinor) : 0;
  return Math.min(rem, due);
}

/**
 * Применяемая сумма как денежная строка: min(остаток, сумма к оплате).
 * remaining/amountDue — строки NUMERIC (домен/БД).
 */
export function computeApplicable(remaining: MoneyString, amountDue: MoneyString): MoneyString {
  return fromMinor(computeApplicableMinor(toMinor(remaining), toMinor(amountDue)));
}

/** Данные для проверки применимости (подмножество GiftCertificate). */
export interface RedeemableCheck {
  status: GiftCertificateStatus;
  initialAmount: MoneyString;
  spentTotal: MoneyString;
  validUntil: Date | null;
}

/**
 * Можно ли списывать с сертификата ПРЯМО СЕЙЧАС: статус active, срок не истёк,
 * остаток > 0. Проверяет срок ЯВНО (не полагаясь только на status='expired' —
 * статус мог не обновиться кроном), поэтому истёкший active тоже отвергается.
 */
export function isRedeemable(cert: RedeemableCheck, now: Date = new Date()): boolean {
  if (cert.status !== 'active') return false;
  if (cert.validUntil != null && cert.validUntil.getTime() <= now.getTime()) return false;
  return remainingMinor(toMinor(cert.initialAmount), toMinor(cert.spentTotal)) > 0;
}

/** Остаток GiftCertificate как строка (удобный хелпер для мапперов/DTO). */
export function certRemaining(cert: Pick<GiftCertificate, 'initialAmount' | 'spentTotal'>): MoneyString {
  return computeRemaining(cert.initialAmount, cert.spentTotal);
}
