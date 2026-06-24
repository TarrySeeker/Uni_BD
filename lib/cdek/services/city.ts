/**
 * CityService — поиск городов СДЭК для автокомплита витрины (GET /v2/location/cities).
 *
 * Выбор источника — по getCdekManager().isMock (как PvzService, docs/08 §11):
 *   • isMock → фикстуры (lib/cdek/mock.mockSearchCities);
 *   • иначе  → manager.client.request к GET /v2/location/cities + маппинг ответа
 *             (СДЭК возвращает массив сырых городов) в доменный CdekCity.
 *
 * Витрине нужен code города (для расчёта доставки и списка ПВЗ), name и region
 * для отображения в выпадашке. Ключи СДЭК на фронт не утекают (прокси-роут).
 */

import type { CdekManager } from '../manager';
import type { CdekCity } from '../types';

/** Сырое тело города из ответа СДЭК /v2/location/cities. */
interface RawCity {
  code?: unknown;
  city?: unknown;
  region?: unknown;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Маппинг сырого города СДЭК → доменный CdekCity (отбрасывает записи без code). */
function mapCity(raw: RawCity): CdekCity | null {
  const code = asNumberOrNull(raw.code);
  if (code === null) return null;
  return {
    code,
    name: asString(raw.city),
    region: asString(raw.region),
  };
}

export class CityService {
  constructor(private readonly manager: CdekManager) {}

  /**
   * Поиск городов по подстроке имени. В mock — фикстуры; в real — GET
   * /v2/location/cities?city=…&country_codes=RU с маппингом. Пустой/короткий
   * запрос (<2 символов) → пустой список (как mock). Устойчив к не-массиву.
   */
  async searchCities(query: string, limit = 10): Promise<CdekCity[]> {
    const q = (query ?? '').trim();
    if (q.length < 2) return [];

    if (this.manager.isMock) {
      return this.manager.mock.mockSearchCities(q);
    }

    const raw = await this.manager.client.request<unknown>('GET', '/v2/location/cities', {
      query: { city: q, size: limit, country_codes: 'RU' },
    });
    if (!Array.isArray(raw)) return [];
    return (raw as RawCity[])
      .map(mapCity)
      .filter((c): c is CdekCity => c !== null);
  }
}
