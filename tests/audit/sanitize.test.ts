import { describe, it, expect } from 'vitest';
import {
  isSensitiveKey,
  sanitizeValue,
  sanitize,
  scrubSecretsInString,
} from '@/lib/audit/sanitize';

/**
 * Контракт санитайзера (lib/audit/sanitize.ts; ADR-015 §6.3).
 *
 * Два уровня защиты от утечки секретов в журнал/лог:
 *   1. По ИМЕНИ ключа — чувствительные ключи (password/token/secret/…) вырезаются
 *      целиком (исходное поведение).
 *   2. По ЗНАЧЕНИЮ — учётные данные, вшитые в строки-значения под НЕсекретным
 *      ключом (например connection string `postgres://user:pass@host` под ключом
 *      `url`), маскируются: пароль в userinfo URL → `***` (бэклог Этапа 6, пункт b).
 */
describe('lib/audit/sanitize — маскирование по имени ключа', () => {
  it('распознаёт чувствительные ключи без учёта регистра и по подстроке', () => {
    for (const k of [
      'password',
      'Password',
      'password_hash',
      'sessionToken',
      'refresh_token',
      'API_SECRET',
      'authorization',
      'apiKey',
      'private_key',
    ]) {
      expect(isSensitiveKey(k)).toBe(true);
    }
    for (const k of ['email', 'name', 'url', 'host', 'count']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });

  it('вырезает чувствительные ключи рекурсивно, не мутируя вход', () => {
    const input = {
      email: 'a@b.c',
      password: 'p',
      nested: { token: 't', keep: 1 },
      list: [{ secret: 's', ok: true }],
    };
    const out = sanitize(input) as Record<string, unknown>;
    expect(out).toEqual({
      email: 'a@b.c',
      nested: { keep: 1 },
      list: [{ ok: true }],
    });
    // вход не мутирован
    expect(input.password).toBe('p');
  });
});

describe('lib/audit/sanitize — маскирование секрета в значении (URL userinfo)', () => {
  it('маскирует пароль в connection string', () => {
    expect(scrubSecretsInString('postgres://admik:secret@postgres:5432/admik')).toBe(
      'postgres://admik:***@postgres:5432/admik',
    );
  });

  it('маскирует пароль без имени пользователя (redis://:pass@…)', () => {
    expect(scrubSecretsInString('redis://:hunter2@redis:6379')).toBe(
      'redis://:***@redis:6379',
    );
  });

  it('маскирует https-креды и несколько вхождений в одной строке', () => {
    expect(
      scrubSecretsInString('see https://u:p1@a.com and amqp://x:p2@b.com now'),
    ).toBe('see https://u:***@a.com and amqp://x:***@b.com now');
  });

  it('НЕ трогает обычные URL без учётных данных, email и SSH-строки', () => {
    for (const s of [
      'postgres://localhost:5432/admik', // порт ≠ креды
      'https://example.com/path?x=1',
      'user@example.com',
      'git@github.com:Owner/Repo.git',
      'обычная строка без секретов',
    ]) {
      expect(scrubSecretsInString(s)).toBe(s);
    }
  });

  it('sanitizeValue маскирует креды в строке-значении под НЕсекретным ключом', () => {
    const out = sanitizeValue({
      url: 'postgres://admik:secret@postgres:5432/admik',
      note: 'connect via redis://:p@redis:6379',
      count: 3,
    });
    expect(out).toEqual({
      url: 'postgres://admik:***@postgres:5432/admik',
      note: 'connect via redis://:***@redis:6379',
      count: 3,
    });
  });

  it('совмещает оба уровня: секретный ключ удалён, а креды в значении замаскированы', () => {
    const out = sanitize({
      password: 'p',
      databaseUrl: 'postgresql://u:pw@db/app',
    }) as Record<string, unknown>;
    expect(out).toEqual({ databaseUrl: 'postgresql://u:***@db/app' });
  });

  it('маскирует креды в строках внутри массивов', () => {
    const out = sanitizeValue(['ok', 'mongodb://u:pw@m:27017/db']);
    expect(out).toEqual(['ok', 'mongodb://u:***@m:27017/db']);
  });
});
