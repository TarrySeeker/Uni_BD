/**
 * PvzService — пункты выдачи заказов СДЭК (docs/08 §6, порт carre PvzService.php).
 *
 * Выбор источника — по getCdekManager().isMock (docs/08 §11):
 *   • isMock → фикстуры (lib/cdek/mock);
 *   • иначе  → manager.client.request к GET /v2/deliverypoints + маппинг ответа
 *             (СДЭК возвращает массив сырых офисов) в доменный CdekOffice.
 *
 * Кеш ПВЗ (Redis 24ч / negative 5мин в carre) — TODO пакета E (storefront-роут);
 * здесь сервис чистый по транспорту, кеш накладывается на уровне роута, чтобы не
 * тащить Redis в unit-тесты сервиса. См. docs/08 §6.3.
 */

import type { CdekManager } from '../manager';
import type { CdekOffice } from '../types';

/** Фильтры списка ПВЗ (docs/08 §6.3). */
export interface ListOfficesInput {
  cityCode?: number;
  postalCode?: string;
  type?: string; // PVZ | POSTAMAT
  countryCode?: string;
}

/** Сырое тело офиса из ответа СДЭК /v2/deliverypoints. */
interface RawOffice {
  code?: unknown;
  name?: unknown;
  type?: unknown;
  work_time?: unknown;
  location?: {
    address_full?: unknown;
    address?: unknown;
    city_code?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  };
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Маппинг сырого офиса СДЭК → доменный CdekOffice. */
function mapOffice(raw: RawOffice): CdekOffice {
  const loc = raw.location ?? {};
  const lat = asNumberOrNull(loc.latitude);
  const lon = asNumberOrNull(loc.longitude);
  return {
    code: asString(raw.code),
    name: asString(raw.name),
    address: asString(loc.address_full ?? loc.address),
    type: asString(raw.type) || 'PVZ',
    cityCode: asNumberOrNull(loc.city_code),
    location: lat !== null && lon !== null ? { latitude: lat, longitude: lon } : null,
    workTime: typeof raw.work_time === 'string' ? raw.work_time : null,
  };
}

export class PvzService {
  constructor(private readonly manager: CdekManager) {}

  /**
   * Список ПВЗ по городу/индексу/типу. В mock — фикстуры с фильтром; в real —
   * GET /v2/deliverypoints с маппингом. Устойчив к не-массиву в ответе.
   */
  async listOffices(input: ListOfficesInput = {}): Promise<CdekOffice[]> {
    if (this.manager.isMock) {
      return this.manager.mock.mockGetOffices({
        cityCode: input.cityCode,
        type: input.type,
      });
    }

    const query: Record<string, string | number> = {};
    if (input.cityCode !== undefined) query.city_code = input.cityCode;
    if (input.postalCode !== undefined) query.postal_code = input.postalCode;
    if (input.type !== undefined) query.type = input.type;
    if (input.countryCode !== undefined) query.country_code = input.countryCode;

    const raw = await this.manager.client.request<unknown>('GET', '/v2/deliverypoints', { query });
    if (!Array.isArray(raw)) return [];
    return (raw as RawOffice[]).map(mapOffice);
  }

  /**
   * Поиск ПВЗ по коду. Пустой код → null. В mock — поиск в фикстурах; в real —
   * GET /v2/deliverypoints?code=… → первый элемент или null.
   */
  async findOffice(code: string): Promise<CdekOffice | null> {
    const trimmed = (code ?? '').trim();
    if (trimmed === '') return null;

    if (this.manager.isMock) {
      return this.manager.mock.mockFindOfficeByCode(trimmed);
    }

    const raw = await this.manager.client.request<unknown>('GET', '/v2/deliverypoints', {
      query: { code: trimmed },
    });
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return mapOffice(raw[0] as RawOffice);
  }
}
