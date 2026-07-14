/**
 * Сервисный слой сертификатов (docs/24 §5): валидация применимости + вычисление
 * применяемой суммы. Тонкий композит над чистым ядром balance.ts и репозиторием.
 *
 * ГРАНИЦА 4a: сервис даёт примитивы валидации/расчёта, но в конвейер
 * quote/createOrder (lib/orders) НЕ включён — интеграция это 4b. Здесь эти
 * функции покрыты юнит-тестами как чистая логика.
 */
import type { MoneyString } from '@/lib/orders/money';

import { computeApplicable, isRedeemable, certRemaining } from './balance';
import { GiftCertificateError } from './errors';
import type { GiftCertificate } from './types';

/**
 * Проверяет, что сертификат можно применить ПРЯМО СЕЙЧАС (active + не истёк +
 * остаток > 0). Бросает доменную ошибку с понятным сообщением иначе.
 * Возвращает остаток (строка NUMERIC) для последующего computeApplicable.
 */
export function assertRedeemable(cert: GiftCertificate, now: Date = new Date()): MoneyString {
  if (cert.status === 'disabled') {
    throw new GiftCertificateError('disabled', 'Подарочный сертификат отключён.');
  }
  if (cert.status === 'depleted') {
    throw new GiftCertificateError('depleted', 'Подарочный сертификат исчерпан.');
  }
  if (cert.status === 'expired') {
    throw new GiftCertificateError('expired', 'Срок действия подарочного сертификата истёк.');
  }
  if (cert.validUntil != null && cert.validUntil.getTime() <= now.getTime()) {
    throw new GiftCertificateError('expired', 'Срок действия подарочного сертификата истёк.');
  }
  const remaining = certRemaining(cert);
  if (!isRedeemable(cert, now)) {
    throw new GiftCertificateError('depleted', 'На подарочном сертификате нет средств.');
  }
  return remaining;
}

/**
 * Применяемая сумма сертификата к сумме к оплате: min(остаток, amountDue).
 * Не мутирует баланс (read-only резолв для quote; списание — redeemGiftTx в 4b).
 * amountDue — нетто-товары после промокода (доставку сертификат не покрывает, 4b).
 */
export function computeApplicableAmount(cert: GiftCertificate, amountDue: MoneyString): MoneyString {
  return computeApplicable(certRemaining(cert), amountDue);
}

/** Результат резолва применимого сертификата (для quote/DTO в 4b). */
export interface GiftApplication {
  certificate: GiftCertificate;
  remaining: MoneyString;
  appliedAmount: MoneyString;
  balanceRemainingAfter: MoneyString;
}

/**
 * Резолвит применение сертификата к сумме к оплате: валидирует применимость,
 * считает applied = min(остаток, amountDue) и остаток после. Чистый расчёт (без
 * записи). Используется quote в 4b; в 4a — покрыт тестами.
 */
export function resolveGiftApplication(
  cert: GiftCertificate,
  amountDue: MoneyString,
  now: Date = new Date(),
): GiftApplication {
  const remaining = assertRedeemable(cert, now);
  const appliedAmount = computeApplicable(remaining, amountDue);
  // Остаток после = remaining − applied (в копейках, точно; ≥ 0 по построению).
  const balanceRemainingAfter = subtractMoney(remaining, appliedAmount);
  return { certificate: cert, remaining, appliedAmount, balanceRemainingAfter };
}

/** Вычитание денежных строк в копейках (remaining − applied ≥ 0 по построению). */
function subtractMoney(a: MoneyString, b: MoneyString): MoneyString {
  const minor = Math.round(Number(a) * 100) - Math.round(Number(b) * 100);
  const safe = Math.max(0, minor);
  const whole = Math.trunc(safe / 100);
  const frac = safe % 100;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}
