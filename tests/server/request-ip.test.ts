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

  it('X-Real-IP есть, XFF нет → берётся X-Real-IP', () => {
    expect(normalizeClientIp(null, '192.0.2.55')).toBe('192.0.2.55');
    expect(normalizeClientIp('', ' 192.0.2.55 ')).toBe('192.0.2.55');
  });

  it('невалидный x-real-ip → падаем на XFF, а не отбрасываем всё', () => {
    expect(normalizeClientIp('203.0.113.7', 'still-not-an-ip')).toBe('203.0.113.7');
    expect(normalizeClientIp(null, 'still-not-an-ip')).toBeUndefined();
  });
});

// =============================================================================
// SECURITY: ПРИОРИТЕТ ИСТОЧНИКОВ. Это не косметика — от него зависит, можно ли
// подделать клиентский IP.
//
// Левый сегмент `X-Forwarded-For` целиком подконтролен клиенту: обратный прокси
// лишь ДОПИСЫВАЕТ реальный адрес справа, а всё, что было прислано, сохраняет.
// `X-Real-IP` наш прокси ПЕРЕЗАПИСЫВАЕТ адресом реального соединения
// (`header_up X-Real-IP {http.request.remote.host}` в Caddyfile) — подделать его
// снаружи нельзя.
//
// Чем это грозило: IP служит ключом лимита попыток входа и пишется в журнал
// аудита. Доверяя `X-Forwarded-For` первым, мы позволяли обходить защиту от
// перебора паролей простой ротацией заголовка и отравлять журнал чужими адресами.
//
// ⚠️ Порядок выкатки: сначала Caddyfile (он начинает перезаписывать X-Real-IP),
// потом код. Обратный порядок открывает окно, в котором код уже доверяет
// заголовку, а прокси его ещё не перезаписывает.
// =============================================================================
describe('normalizeClientIp — доверие источнику (защита от подделки IP)', () => {
  it('X-Real-IP ПОБЕЖДАЕТ X-Forwarded-For: прокси перезаписывает его, клиент — нет', () => {
    // Клиент прислал «свой» адрес в XFF, прокси проставил настоящий в X-Real-IP.
    expect(normalizeClientIp('203.0.113.7', '192.0.2.55')).toBe('192.0.2.55');
  });

  it('подделанный XFF из whitelist не подменяет реальный адрес соединения', () => {
    // Классическая попытка обхода: прислать в XFF адрес, которому система доверяет.
    expect(normalizeClientIp('127.0.0.1', '198.51.100.9')).toBe('198.51.100.9');
  });

  it('ротация XFF не даёт свежий ключ лимита: адрес берётся из X-Real-IP', () => {
    const real = '198.51.100.9';
    const seen = new Set([
      normalizeClientIp('1.1.1.1', real),
      normalizeClientIp('2.2.2.2', real),
      normalizeClientIp('3.3.3.3', real),
    ]);
    // Все попытки схлопываются в ОДИН ключ — перебор упрётся в лимит.
    expect([...seen]).toEqual([real]);
  });

  it('без доверенного прокси (X-Real-IP пуст) XFF всё ещё используется', () => {
    // Деградация осознанная: за нашим прокси X-Real-IP есть всегда, а вне его
    // диагностический IP лучше иметь приблизительным, чем не иметь вовсе.
    expect(normalizeClientIp('203.0.113.7, 10.0.0.1', null)).toBe('203.0.113.7');
  });
});
