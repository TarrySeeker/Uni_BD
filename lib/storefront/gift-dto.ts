/**
 * Публичный DTO подарочного сертификата в корзине (docs/24 §5).
 *
 * Витрина применяет КОД сертификата к корзине и видит только: применён ли он,
 * сколько списалось (appliedAmount) и сколько ОСТАНЕТСЯ на балансе после заказа
 * (balanceRemainingAfter). Номинал (faceValue) и суммарно потраченное (spentTotal)
 * НЕ раскрываются — это бирер-инструмент, публичная утечка баланса не нужна.
 */

import type { GiftQuoteInfo } from '@/lib/orders/repository';

/** Блок подарочного сертификата в ответе /cart/quote (скрывает faceValue/spentTotal). */
export interface GiftQuoteDto {
  /** Сертификат реально уменьшил сумму к оплате. */
  applied: boolean;
  /** Эхо переданного кода (для UI). */
  code: string;
  /** Списано сертификатом на этот заказ (NUMERIC-строка). */
  appliedAmount: string;
  /** Остаток сертификата ПОСЛЕ применения (для «останется N ₽»). */
  balanceRemainingAfter: string;
  /** Машиночитаемая причина, если не применён (not_found/expired/depleted/…); null — применён. */
  reason: string | null;
}

/** GiftQuoteInfo (домен) → публичный DTO. null → сертификат к корзине не применяли. */
export function toGiftQuoteDto(gift: GiftQuoteInfo | null): GiftQuoteDto | null {
  if (!gift) return null;
  return {
    applied: gift.applied,
    code: gift.code,
    appliedAmount: gift.appliedAmount,
    balanceRemainingAfter: gift.balanceRemainingAfter,
    reason: gift.reason,
  };
}
