/**
 * Общие хелперы защиты cron-роутов секретом (переиспользуются всеми
 * /api/cron/* роутами: cdek, payments, …).
 *
 * Секрет принимается из query (?key=) ИЛИ заголовка X-Cron-Secret. Сравнение —
 * постоянное по времени (анти-timing). Источник самого секрета (env-переменная)
 * остаётся за вызывающим роутом — исторически это CDEK_CRON_SECRET, общий для
 * всех cron-роутов инстанса.
 */

import type { NextRequest } from 'next/server';

/** Извлекает cron-секрет из ?key= или заголовка X-Cron-Secret (null, если нет). */
export function extractCronSecret(req: NextRequest): string | null {
  const fromQuery = req.nextUrl.searchParams.get('key');
  if (fromQuery) return fromQuery;
  const fromHeader = req.headers.get('x-cron-secret');
  return fromHeader && fromHeader.length > 0 ? fromHeader : null;
}

/** Постоянное по времени сравнение секрета (анти-timing). */
export function cronSecretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
