/**
 * Прод-зависимости воркера курсов валют (lib/exchange/cron.ts).
 *
 * Читает/пишет ключ настроек `exchange` через тот же слой, что и admin-форма
 * (settings/repository + invalidateSettingsCache) — НЕ прямой SQL из cron. Запись
 * идёт от системного автора (updated_by = null): у cron нет пользователя. Значение
 * валидируется exchangeSchema перед записью (анти-tamper JSONB), rateUpdatedAt
 * ставится здесь = момент успешного авто-обновления курса.
 */

import { getSetting, upsertSetting } from '@/lib/settings/repository';
import { invalidateSettingsCache } from '@/lib/config/settings';
import { parseSettingValue, type ExchangeSettings } from '@/lib/settings/schemas';
import {
  runUpdateExchangeRates,
  defaultFetchCbr,
  type UpdateRatesDeps,
  type UpdateRatesStats,
} from './cron';

/** Читает текущий exchange из БД (через репозиторий), мягкий парс схемой. */
async function readExchangeFromDb(): Promise<ExchangeSettings> {
  const row = await getSetting('exchange');
  return parseSettingValue('exchange', row?.value) ?? {};
}

/**
 * Пишет обновлённый exchange: валидирует схемой, ставит rateUpdatedAt = сейчас,
 * апсертит от системного автора, инвалидирует memo эффективных настроек
 * (read-your-own-writes — витрина сразу увидит новый курс).
 */
async function writeExchangeToDb(value: ExchangeSettings): Promise<void> {
  const toStore: ExchangeSettings = {
    ...value,
    rateUpdatedAt: new Date().toISOString(),
  };
  // Ре-валидация схемой перед записью (rate>0 и т.п.) — как admin-путь.
  const parsed = parseSettingValue('exchange', toStore);
  if (!parsed) {
    throw new Error('exchange: значение не прошло валидацию схемой перед записью');
  }
  await upsertSetting('exchange', parsed as Record<string, unknown>, null);
  invalidateSettingsCache();
}

/** Прод-зависимости воркера (реальный fetch ЦБ + чтение/запись настроек). */
export function productionExchangeDeps(): UpdateRatesDeps {
  return {
    fetchCbr: () => defaultFetchCbr(),
    readExchange: readExchangeFromDb,
    writeExchange: writeExchangeToDb,
  };
}

/** Прод-обёртка прогона обновления курсов (дёргается cron-роутом). */
export async function runUpdateExchangeRatesProd(): Promise<UpdateRatesStats> {
  return runUpdateExchangeRates(productionExchangeDeps());
}
