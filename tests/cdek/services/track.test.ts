import { describe, it, expect } from 'vitest';

/**
 * Находка аудита №25: в боевом режиме ТРЕК-НОМЕР СДЭК не сохранялся НИКОГДА.
 *
 * Факты на момент находки:
 *   • order.ts (создание накладной) в боевой ветке пишет `cdekNumber = null` —
 *     СДЭК на POST /v2/orders отдаёт только uuid, номер присваивается позже;
 *   • webhook.ts разбирал `attributes.cdek_number` в CdekEvent.cdekNumber и
 *     ВЫБРАСЫВАЛ его — в БД он не попадал;
 *   • tracking.ts обновлял только статус отправления.
 * Итог: orders.cdek_track оставался NULL, и покупателю (order-dto.delivery.track)
 * показывать было нечего.
 *
 * Здесь — ЧИСТЫЙ слой разбора/нормализации трека (без сети и БД). Запись в БД
 * (saveTrackNumber) проверяется через моки в webhook/tracking-тестах.
 */

import {
  normalizeTrackNumber,
  trackFromTrackingResponse,
} from '@/lib/cdek/services/track';

describe('cdek/track — normalizeTrackNumber (чистая)', () => {
  it('строка с номером → сам номер', () => {
    expect(normalizeTrackNumber('1106109745')).toBe('1106109745');
  });

  it('обрезает пробелы по краям (СДЭК присылает с хвостами)', () => {
    expect(normalizeTrackNumber('  1106109745 \n')).toBe('1106109745');
  });

  it('пустая строка / только пробелы → null (не затираем сохранённый трек пустотой)', () => {
    expect(normalizeTrackNumber('')).toBeNull();
    expect(normalizeTrackNumber('   ')).toBeNull();
  });

  it('не-строка (null/undefined/число/объект) → null', () => {
    expect(normalizeTrackNumber(null)).toBeNull();
    expect(normalizeTrackNumber(undefined)).toBeNull();
    expect(normalizeTrackNumber(1106109745)).toBeNull();
    expect(normalizeTrackNumber({ cdek_number: '1' })).toBeNull();
  });
});

describe('cdek/track — trackFromTrackingResponse (чистая)', () => {
  it('берёт entity.cdek_number из ответа GET /v2/orders/{uuid}', () => {
    const raw = {
      entity: {
        uuid: 'u-1',
        cdek_number: '1106109745',
        statuses: [{ code: 'ACCEPTED', date_time: '2026-07-01T10:00:00+0300' }],
      },
    };
    expect(trackFromTrackingResponse(raw)).toBe('1106109745');
  });

  it('поддерживает camelCase-вариант entity.cdekNumber', () => {
    expect(trackFromTrackingResponse({ entity: { cdekNumber: '777' } })).toBe('777');
  });

  it('номер ещё не присвоен (нет поля / пусто) → null', () => {
    expect(trackFromTrackingResponse({ entity: { statuses: [] } })).toBeNull();
    expect(trackFromTrackingResponse({ entity: { cdek_number: '' } })).toBeNull();
  });

  it('мусорный ответ (не объект / без entity) → null, без падения', () => {
    expect(trackFromTrackingResponse(null)).toBeNull();
    expect(trackFromTrackingResponse('nope')).toBeNull();
    expect(trackFromTrackingResponse({})).toBeNull();
  });
});
