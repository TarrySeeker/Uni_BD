/**
 * Публичный DTO подарочного сертификата в корзине (docs/24 §5).
 *
 * Витрина применяет КОД сертификата к корзине и видит только: применён ли он,
 * сколько списалось (appliedAmount) и сколько ОСТАНЕТСЯ на балансе после заказа
 * (balanceRemainingAfter). Номинал (faceValue) и суммарно потраченное (spentTotal)
 * НЕ раскрываются — это бирер-инструмент, публичная утечка баланса не нужна.
 */

import type { GiftQuoteInfo } from '@/lib/orders/repository';
import { publicGiftReason } from './code-privacy';

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
  /**
   * Машиночитаемая причина, если не применён; null — применён.
   * СКЛЕЕНА (публичный алфавит GIFT_REJECT_REASONS): «нет такого кода» и «код
   * есть, но истёк/исчерпан/отключён» неразличимы — иначе ответ работал бы
   * оракулом существования сертификатов. См. ./code-privacy.ts.
   */
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
    // 🔴 АУДИТ (безопасность): точная причина НЕ уезжает наружу. Различие
    // not_found / expired / depleted / disabled подтверждало СУЩЕСТВОВАНИЕ кода
    // и превращало /cart/quote в оракул для угадывания сертификатов (деньги на
    // предъявителя). Здесь — единственная граница, где домен становится
    // публичным DTO, поэтому склейка стоит именно тут. См. ./code-privacy.ts.
    reason: publicGiftReason(gift.reason),
  };
}
