/**
 * РЕЕСТР ПЛАТЁЖНЫХ ПРОВАЙДЕРОВ — одна точка, где магазин выбирает свой эквайринг.
 *
 * Правило выбора (по убыванию приоритета):
 *   1. `PAYMENTS_PROVIDER` в .env — явная воля владельца магазина;
 *   2. единственный провайдер с боевыми ключами — если задан ровно один,
 *      магазин очевидно работает через него, требовать ещё и переменную незачем;
 *   3. дефолт `tbank` — историческое поведение платформы (обратная совместимость:
 *      магазин, поднятый до появления реестра, продолжает работать как раньше).
 *
 * 🔴 ПОЧЕМУ НЕ «ПРОСТО ИМПОРТИРОВАТЬ НУЖНЫЙ СЕРВИС». Именно так и было: заказы
 * импортировали Т-Банк напрямую, из-за чего возврат денег из админки работал
 * только у магазина на Т-Банке, а у остальных молча отвечал «возврат не нужен»
 * при списанных деньгах. Провайдер обязан выбираться в ОДНОМ месте, иначе
 * следующий эквайер снова разъедется по коду копипастой.
 */

import { logger } from '@/lib/logger';
import type { PaymentProvider, PaymentProviderCode } from '@/lib/payments/types';
import { TbankProviderAdapter, OzonProviderAdapter, AtolProviderAdapter } from './adapters';

const log = logger.child({ module: 'payments.registry' });

/** Фабрики известных провайдеров. Новый эквайер добавляется ОДНОЙ строкой сюда. */
const FACTORIES: Record<string, () => PaymentProvider> = {
  tbank: () => new TbankProviderAdapter(),
  ozon: () => new OzonProviderAdapter(),
  atol: () => new AtolProviderAdapter(),
};

/** Провайдер по умолчанию — поведение платформы до появления реестра. */
export const DEFAULT_PAYMENT_PROVIDER: PaymentProviderCode = 'tbank';

/** Коды всех известных платформе провайдеров. */
export function knownPaymentProviders(): PaymentProviderCode[] {
  return Object.keys(FACTORIES);
}

/** Создать провайдер по коду. `null` — код неизвестен. */
export function createPaymentProvider(code: string): PaymentProvider | null {
  const factory = FACTORIES[code];
  return factory ? factory() : null;
}

/**
 * Код активного провайдера магазина. Чистая функция от окружения — тестируема
 * без сети и БД.
 */
export function resolvePaymentProviderCode(
  source: Record<string, string | undefined> = process.env,
): PaymentProviderCode {
  const explicit = (source.PAYMENTS_PROVIDER ?? '').trim().toLowerCase();
  if (explicit) {
    if (FACTORIES[explicit]) return explicit;
    // Опечатка в имени провайдера не должна ТИХО уводить магазин на чужой
    // эквайринг: жалуемся в лог и падаем на дефолт.
    log.warn('PAYMENTS_PROVIDER указывает на неизвестного провайдера — беру дефолт', {
      requested: explicit,
      known: knownPaymentProviders(),
      fallback: DEFAULT_PAYMENT_PROVIDER,
    });
    return DEFAULT_PAYMENT_PROVIDER;
  }

  // Автоопределение: ровно один провайдер с боевыми ключами — берём его.
  const configured = knownPaymentProviders().filter((code) => {
    try {
      return createPaymentProvider(code)?.isConfigured() ?? false;
    } catch {
      return false;
    }
  });
  if (configured.length === 1) return configured[0];

  return DEFAULT_PAYMENT_PROVIDER;
}

/** Активный провайдер магазина. */
export function getPaymentProvider(
  source: Record<string, string | undefined> = process.env,
): PaymentProvider {
  const code = resolvePaymentProviderCode(source);
  const provider = createPaymentProvider(code);
  if (!provider) {
    // Недостижимо: resolve возвращает только известный код. Явная ошибка лучше
    // молчаливого null в платёжном пути.
    throw new Error(`Неизвестный платёжный провайдер: ${code}`);
  }
  return provider;
}

/**
 * Провайдер, которым БЫЛ оплачен КОНКРЕТНЫЙ заказ (`orders.payment_provider`).
 *
 * 🔴 Для возврата денег брать активный провайдер магазина НЕЛЬЗЯ: эквайер могли
 * сменить уже после оплаты, и тогда возврат ушёл бы не в тот банк (или молча
 * «пропустился»). Возврат всегда идёт тем провайдером, который принял платёж.
 */
export function getProviderForOrder(
  paymentProvider: string | null | undefined,
): PaymentProvider | null {
  if (!paymentProvider) return null;
  return createPaymentProvider(paymentProvider);
}
