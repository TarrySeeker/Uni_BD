/**
 * GET /api/storefront/v1/delivery/cdek/cities — поиск городов СДЭК для
 * автокомплита города на витрине (docs/08 §6.1, ADR-008; docs/13 §2 — гэп).
 * Прокси к СДЭК: ключи не утекают на фронт.
 *
 * Конвейер runStorefront: module-gate `cdek` (404 при выключенном) →
 * authorizeStorefront (401/403) → rate-limit (429) → CORS. В mock-режиме СДЭК
 * (пустые CDEK_*) отдаёт фикстуры без сети.
 *
 * Query: q (подстрока имени города, ≥2 символов); опц. limit.
 * Ответ: { data: [{ code, name, region }] }. code нужен для расчёта/ПВЗ.
 */

import {
  runStorefront,
  jsonData,
  handlePreflight,
} from '@/lib/storefront/response';
import { STOREFRONT_METHODS } from '@/lib/storefront/cors';
import { getCdekManager } from '@/lib/cdek/manager';
import { CityService } from '@/lib/cdek/services/city';

export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const url = new URL(req.url);
      const q = url.searchParams.get('q') ?? '';
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw ? Math.min(50, Math.max(1, Math.trunc(Number(limitRaw)) || 10)) : 10;

      // Короткий запрос (<2) → пустой список (без обращения к СДЭК) — сервис сам так делает.
      const cities = new CityService(getCdekManager());
      const data = await cities.searchCities(q, limit);

      return jsonData(data, {}, cors);
    },
    { module: 'cdek', methods: STOREFRONT_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_METHODS);
}
