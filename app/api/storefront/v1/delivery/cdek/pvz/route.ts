/**
 * GET /api/storefront/v1/delivery/cdek/pvz — список ПВЗ/постаматов СДЭК для
 * витрины (docs/08 §6.1, ADR-008). Прокси к СДЭК: ключи не утекают на фронт.
 *
 * Конвейер runStorefront: module-gate `cdek` (404 при выключенном) →
 * authorizeStorefront (401/403) → rate-limit (429) → CORS. В mock-режиме СДЭК
 * (пустые CDEK_*) отдаёт фикстуры без сети.
 *
 * Query: city_code (int) ИЛИ postal_code; опц. type=PVZ|POSTAMAT, country_code.
 * Ответ: { data: [{ code, name, address, location:{latitude,longitude}|null,
 *           workTime, type }] } — без внутренних полей (cityCode и пр. скрыты).
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
} from '@/lib/storefront/response';
import { STOREFRONT_METHODS } from '@/lib/storefront/cors';
import { getCdekManager } from '@/lib/cdek/manager';
import { PvzService } from '@/lib/cdek/services/pvz';
import type { CdekOffice } from '@/lib/cdek/types';

export const dynamic = 'force-dynamic';

/** Публичный DTO ПВЗ (без внутренних полей вроде cityCode). */
function toPvzDto(o: CdekOffice) {
  return {
    code: o.code,
    name: o.name,
    address: o.address,
    type: o.type,
    location: o.location,
    workTime: o.workTime,
  };
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const url = new URL(req.url);
      const cityCodeRaw = url.searchParams.get('city_code');
      const postalCode = url.searchParams.get('postal_code') ?? undefined;
      const type = url.searchParams.get('type') ?? undefined;
      const countryCode = url.searchParams.get('country_code') ?? undefined;

      let cityCode: number | undefined;
      if (cityCodeRaw !== null && cityCodeRaw !== '') {
        const n = Number(cityCodeRaw);
        if (!Number.isFinite(n)) {
          return jsonError('bad_request', 'city_code должен быть числом.', cors);
        }
        cityCode = Math.trunc(n);
      }

      if (cityCode === undefined && !postalCode) {
        return jsonError(
          'bad_request',
          'Требуется city_code или postal_code.',
          cors,
        );
      }

      const pvz = new PvzService(getCdekManager());
      const offices = await pvz.listOffices({ cityCode, postalCode, type, countryCode });

      return jsonData(offices.map(toPvzDto), {}, cors);
    },
    { module: 'cdek', methods: STOREFRONT_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_METHODS);
}
