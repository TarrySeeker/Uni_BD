import { describe, expect, it } from 'vitest';

import { normalizeClientIp } from '@/lib/server/request-ip';

// =============================================================================
// ЮНИТ-тесты нормализации клиентского IP (lib/server/request-ip.ts).
//
// КОНТЕКСТ БАГА (major, reliability):
//   Раньше IP брался из X-Forwarded-For ДОСЛОВНО: `forwarded.split(',')[0].trim()`.
//   Этот сырой строковый IP шёл в колонку `inet` (sessions.ip / audit_log.ip).
//   Кривой/подделанный заголовок ('not-an-ip', мусор) → Postgres падает на касте
//   к inet → INSERT сессии падает → ЛОГИН СЛОМАН. Подделать X-Forwarded-For
//   тривиально, но и обычный битый прокси-заголовок ломает вход.
//
// ФИКС: normalizeClientIp валидирует кандидата через node:net isIP() ДО любого
//   inet-INSERT. Невалидный → undefined (не доверяем мусору). Это чистая
//   dependency-free функция → тестируется ВСЕГДА, без next/headers и БД.
// =============================================================================

describe('normalizeClientIp — валидация IP перед записью в колонку inet', () => {
  it('мусорный X-Forwarded-For ("garbage") → undefined (не "garbage")', () => {
    expect(normalizeClientIp('garbage', null)).toBeUndefined();
  });

  it('мусор в первом сегменте списка → undefined (не доверяем подделке)', () => {
    expect(normalizeClientIp('not-an-ip, 10.0.0.1', null)).toBeUndefined();
  });

  it('валидный IPv4 в списке "203.0.113.7, 10.0.0.1" → "203.0.113.7" (первый)', () => {
    expect(normalizeClientIp('203.0.113.7, 10.0.0.1', null)).toBe('203.0.113.7');
  });

  it('одиночный валидный IPv4 без списка → как есть', () => {
    expect(normalizeClientIp('198.51.100.4', null)).toBe('198.51.100.4');
  });

  it('валидный IPv6 → как есть', () => {
    expect(
      normalizeClientIp('2001:db8::8a2e:370:7334', null),
    ).toBe('2001:db8::8a2e:370:7334');
  });

  it('пустой/отсутствующий X-Forwarded-For → undefined', () => {
    expect(normalizeClientIp(null, null)).toBeUndefined();
    expect(normalizeClientIp('', null)).toBeUndefined();
    expect(normalizeClientIp(undefined, undefined)).toBeUndefined();
  });

  it('строка из одних пробелов → undefined', () => {
    expect(normalizeClientIp('   ', null)).toBeUndefined();
  });

  it('тримит пробелы вокруг валидного IP', () => {
    expect(normalizeClientIp('  203.0.113.7  ', null)).toBe('203.0.113.7');
  });

  it('XFF пуст/невалиден → fallback на валидный x-real-ip', () => {
    expect(normalizeClientIp(null, '192.0.2.55')).toBe('192.0.2.55');
    expect(normalizeClientIp('garbage', '192.0.2.55')).toBe('192.0.2.55');
    expect(normalizeClientIp('', ' 192.0.2.55 ')).toBe('192.0.2.55');
  });

  it('невалидный x-real-ip тоже отбрасывается → undefined', () => {
    expect(normalizeClientIp(null, 'still-not-an-ip')).toBeUndefined();
  });

  it('XFF имеет приоритет над x-real-ip, когда XFF валиден', () => {
    expect(normalizeClientIp('203.0.113.7', '192.0.2.55')).toBe('203.0.113.7');
  });
});
