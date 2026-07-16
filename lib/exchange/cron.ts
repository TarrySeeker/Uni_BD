/**
 * Cron-воркер обновления курсов валют ОТОБРАЖЕНИЯ с ЦБ РФ (мультивалюта витрины).
 *
 * Решение владельца: базовая валюта = RUB (цены/оплата в рублях). Евро и прочие
 * доп.валюты — только показ по курсу. Курс тянется автоматически с публичного API
 * ЦБ РФ (cbr-xml-daily), плюс ручной override в админке (fallback, если ЦБ недоступен).
 *
 * Источник: https://www.cbr-xml-daily.ru/daily_json.js — JSON вида
 *   { "Valute": { "EUR": { "Value": 100.5, "Nominal": 1, ... }, "USD": {...} } }
 * где Value = рублей за Nominal единиц валюты. rate (единиц базовой за 1 единицу
 * отображаемой) = Value / Nominal. Для EUR обычно Nominal=1 → rate = Value.
 *
 * Логика — ЧИСТАЯ и ТЕСТИРУЕМАЯ через инъекцию deps (fetch ЦБ + чтение/запись
 * настроек через тот же слой, что и admin-форма — НЕ прямой SQL). По умолчанию deps
 * реальные; в тестах подменяются моком (курс из фикстуры, без сети/БД).
 *
 * Гарантии:
 *  • идемпотентность — повторный прогон лишь перезаписывает rate тем же значением;
 *  • устойчивость — сетевая/парс-ошибка ЦБ НЕ роняет прогон: прежний курс
 *    сохраняется, ошибка логируется, возвращается { ok:false, reason };
 *  • no-op при autoRate=false (магазин ведёт курс вручную) и при отсутствии
 *    доп.валют (нечего обновлять).
 *
 * Зона: lib/exchange/*. Пишет ТОЛЬКО ключ настроек `exchange` через инъецируемый
 * writeExchange (в проде — updateExchangeRateFromCron → repository + invalidateCache).
 */

import type { ExchangeSettings, DisplayCurrencySetting } from '@/lib/settings/schemas';

/** Публичный URL JSON ЦБ РФ (cbr-xml-daily). Переопределяется env EXCHANGE_CBR_URL. */
export const CBR_JSON_URL = 'https://www.cbr-xml-daily.ru/daily_json.js';

/** Одна запись валюты в ответе ЦБ (нас интересуют Value и Nominal). */
export interface CbrValute {
  Value: number;
  Nominal: number;
}

/** Ответ ЦБ РФ (daily_json.js) — берём только карту Valute. */
export interface CbrResponse {
  Valute: Record<string, CbrValute>;
}

/** Статистика прогона обновления курсов. */
export interface UpdateRatesStats {
  ok: boolean;
  /** Сколько доп.валют реально обновлено (курс с ЦБ найден и записан). */
  updated: number;
  /** Валюты, которых нет в ответе ЦБ (курс оставлен прежним). */
  missing: string[];
  /**
   * Причина, по которой прогон не обновил курсы (для лога/диагностики):
   *   'auto_rate_off'   — autoRate выключен (магазин ведёт курс вручную) — no-op;
   *   'no_currencies'   — доп.валют нет — нечего обновлять — no-op;
   *   'fetch_failed'    — ЦБ недоступен/невалидный JSON — прежний курс сохранён;
   *   undefined         — успешный прогон.
   */
  reason?: 'auto_rate_off' | 'no_currencies' | 'fetch_failed';
}

/**
 * Извлекает курс (rate = единиц базовой за 1 единицу валюты) из ответа ЦБ по коду
 * ISO 4217. rate = Value / Nominal. Возвращает null, если валюты нет в ответе или
 * данные некорректны (Value/Nominal не положительные числа) — курс оставим прежним.
 */
export function extractRate(cbr: CbrResponse, code: string): number | null {
  const v = cbr.Valute?.[code];
  if (!v) return null;
  const value = Number(v.Value);
  const nominal = Number(v.Nominal);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (!Number.isFinite(nominal) || nominal <= 0) return null;
  return value / nominal;
}

/**
 * ЧИСТЫЙ пересчёт: обновляет rate у каждой доп.валюты по данным ЦБ. Валюты, для
 * которых ЦБ не дал курс, остаются с прежним rate (собираются в missing). Базовая
 * валюта и остальные поля (symbol/fractionDigits) не трогаются. Идемпотентно.
 */
export function applyCbrRates(
  currencies: DisplayCurrencySetting[],
  cbr: CbrResponse,
): { currencies: DisplayCurrencySetting[]; updated: number; missing: string[] } {
  const missing: string[] = [];
  let updated = 0;
  const next = currencies.map((c) => {
    const rate = extractRate(cbr, c.code);
    if (rate === null) {
      missing.push(c.code);
      return c; // ЦБ не дал курс — сохраняем прежний (ручной/предыдущий).
    }
    updated += 1;
    return { ...c, rate };
  });
  return { currencies: next, updated, missing };
}

/** Инъецируемые зависимости воркера (для тестов без сети/БД). */
export interface UpdateRatesDeps {
  /** Тянет и парсит JSON ЦБ РФ. Бросает при сетевой/парс-ошибке. */
  fetchCbr: () => Promise<CbrResponse>;
  /** Текущее значение настройки exchange (через слой настроек, не прямой SQL). */
  readExchange: () => Promise<ExchangeSettings>;
  /**
   * Записывает обновлённый exchange (через тот же слой, что admin-форма →
   * repository + invalidateCache). Ставит rateUpdatedAt внутри реализации.
   */
  writeExchange: (value: ExchangeSettings) => Promise<void>;
}

/**
 * update-rates (по расписанию, напр. раз в час/сутки): если autoRate включён и есть
 * доп.валюты — тянет курсы с ЦБ РФ и записывает их в настройку exchange. При сбое
 * ЦБ прежние курсы сохраняются, прогон возвращает { ok:false, reason:'fetch_failed' }.
 * No-op (ok:true) при autoRate=false или отсутствии доп.валют.
 */
export async function runUpdateExchangeRates(
  deps: UpdateRatesDeps,
): Promise<UpdateRatesStats> {
  const exchange = await deps.readExchange();
  const currencies = exchange.displayCurrencies ?? [];

  // Магазин ведёт курс вручную → крон не трогает (ручной override приоритетен).
  if (exchange.autoRate !== true) {
    return { ok: true, updated: 0, missing: [], reason: 'auto_rate_off' };
  }
  // Нет доп.валют → нечего обновлять.
  if (currencies.length === 0) {
    return { ok: true, updated: 0, missing: [], reason: 'no_currencies' };
  }

  let cbr: CbrResponse;
  try {
    cbr = await deps.fetchCbr();
  } catch (err) {
    // ЦБ недоступен/невалидный JSON: НЕ роняем прогон — прежний курс сохраняется,
    // ошибку логируем (fallback на ручной/предыдущий rate). Идемпотентно повторится.
    console.warn(
      '[exchange/update-rates] ЦБ РФ недоступен, курс оставлен прежним:',
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false, updated: 0, missing: [], reason: 'fetch_failed' };
  }

  const { currencies: nextCurrencies, updated, missing } = applyCbrRates(currencies, cbr);

  // Записываем ЦЕЛИКОМ обновлённый exchange (сохраняем autoRate; rateUpdatedAt
  // проставит writeExchange). Пишем даже если updated=0, но какие-то валюты нашлись?
  // Нет: если ни одна не обновлена (все в missing) — не трогаем метку, no-op записи.
  if (updated > 0) {
    await deps.writeExchange({
      ...exchange,
      displayCurrencies: nextCurrencies,
    });
  }

  return { ok: true, updated, missing };
}

/**
 * Дефолтный fetch ЦБ РФ: GET cbr-xml-daily → JSON. Таймаут через AbortController,
 * чтобы зависший ЦБ не держал прогон. URL из env EXCHANGE_CBR_URL или дефолт.
 */
export async function defaultFetchCbr(
  url: string = process.env.EXCHANGE_CBR_URL || CBR_JSON_URL,
  timeoutMs = 10_000,
): Promise<CbrResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      throw new Error(`ЦБ РФ вернул ${res.status}`);
    }
    const json = (await res.json()) as CbrResponse;
    if (!json || typeof json !== 'object' || !json.Valute) {
      throw new Error('ЦБ РФ: неожиданная форма ответа (нет поля Valute)');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}
