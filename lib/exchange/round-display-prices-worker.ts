/**
 * Cron-воркер пересчёта витринных ценников в доп.валютах.
 *
 * Решение владельца (29.07.2026): цены в евро показывать КРУГЛЫМИ и держать
 * АКТУАЛЬНЫМИ. Одного разового проставления мало — при движении курса ЦБ
 * зафиксированный ярлык разъезжается с рублёвой ценой (товар «дешевеет» в евро
 * при росте курса). Поэтому пересчёт идёт задачей крона, следом за обновлением
 * курсов.
 *
 * 🔴 Здесь считается ЯРЛЫК ВИТРИНЫ, а не деньги. Оплата и итоги заказа всегда
 * идут от base_price в базовой валюте (ADR-010). Guard-тесты сторожат, что
 * display_prices не просачивается в платёжный путь.
 *
 * Логика инъектируется (как в runUpdateExchangeRates) — воркер тестируется без
 * БД и сети. Дефолтные зависимости живут в `default-deps.ts`, чтобы этот модуль
 * оставался чистым.
 */

import {
  planDisplayPriceUpdates,
  type RoundablePricePolicy,
  type RoundableProduct,
} from './round-display-prices';

/** Итог прогона — в том же духе, что UpdateRatesStats. */
export interface RoundPricesStats {
  ok: boolean;
  /** Сколько товаров просмотрено. */
  scanned: number;
  /** Сколько товаров реально обновлено. */
  updated: number;
  /** Почему прогон не сделал работу (если не сделал). */
  reason?: string;
}

interface DisplayCurrencyLike {
  code: string;
  rate: number;
}

export interface RoundDisplayPricesDeps {
  /** Настройки курсов магазина (тот же ключ, что читает витрина). */
  readExchange: () => Promise<{ displayCurrencies: DisplayCurrencyLike[] }>;
  /** Страница каталога: товары, начиная со смещения. Пустой массив = конец. */
  readProductsPage: (offset: number, limit: number) => Promise<RoundableProduct[]>;
  /** Запись пересчитанных ярлыков. */
  writeDisplayPrices: (
    rows: { id: string; displayPrices: Record<string, string> }[],
  ) => Promise<void>;
  /** Размер страницы обхода. */
  pageSize?: number;
  /** Политика округления (по умолчанию — до целой единицы валюты). */
  policy?: RoundablePricePolicy;
}

/**
 * Размер страницы. Каталог в 846 товаров одним SELECT и одним UPDATE — это
 * долгая транзакция и блокировки на живом магазине; ходим порциями.
 */
const DEFAULT_PAGE_SIZE = 200;

/** Страховка от бесконечного цикла, если источник страниц ведёт себя странно. */
const MAX_PAGES = 1000;

export async function runRoundDisplayPrices(
  deps: RoundDisplayPricesDeps,
): Promise<RoundPricesStats> {
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const policy = deps.policy ?? { mode: 'whole' as const };

  const exchange = await deps.readExchange();
  const currencies = exchange?.displayCurrencies ?? [];

  // Магазин без доп.валют — не ошибка, а норма (одновалютная витрина).
  if (currencies.length === 0) {
    return { ok: true, scanned: 0, updated: 0, reason: 'no_display_currencies' };
  }

  // Валюты с негодным курсом отсеиваем здесь: ниже они просто не попадут в план,
  // а уже проставленные цены по ним останутся нетронутыми.
  const rates: Record<string, number> = {};
  for (const c of currencies) {
    if (c && typeof c.code === 'string' && Number.isFinite(c.rate) && c.rate > 0) {
      rates[c.code] = c.rate;
    }
  }

  if (Object.keys(rates).length === 0) {
    return { ok: true, scanned: 0, updated: 0, reason: 'no_usable_rates' };
  }

  let scanned = 0;
  let updated = 0;
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const products = await deps.readProductsPage(offset, pageSize);
    if (!products || products.length === 0) break;

    scanned += products.length;
    const plan = planDisplayPriceUpdates(products, rates, policy);

    if (plan.length > 0) {
      try {
        await deps.writeDisplayPrices(plan);
      } catch {
        // Молчаливый успех при незаписанных ценах — худший исход: витрина
        // осталась бы со старыми ярлыками, а крон отрапортовал бы «готово».
        return { ok: false, scanned, updated, reason: 'write_failed' };
      }
      updated += plan.length;
    }

    offset += products.length;
  }

  return { ok: true, scanned, updated };
}
