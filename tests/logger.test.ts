import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createLogger,
  formatLine,
  type LogLevel,
} from '@/lib/logger';

/**
 * Контракт lib/logger.ts (Этап 6, пакет 6.3, §6.3.1; ADR-015 §6.3).
 *
 * Логгер выводит ОДНУ JSON-строку на событие в stdout: {ts, level, msg, ...context}.
 * Уровни фильтруются по LOG_LEVEL. Секреты (password/token/secret/...) НЕ утекают —
 * переиспользуется санитайзер lib/audit/log.ts. child() добавляет контекст ко всем
 * событиям. LOG_PRETTY=true даёт человекочитаемый вывод (не обязательно JSON).
 *
 * stdout перехватывается через мок console.log — без реальной записи в поток.
 */

describe('lib/logger', () => {
  let lines: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  /** Создаёт логгер с перехватом вывода в массив lines. */
  function makeLogger(env: Record<string, string | undefined> = {}) {
    return createLogger({ env, sink: (line) => lines.push(line) });
  }

  beforeEach(() => {
    lines = [];
    // Подстраховка: даже если sink не передан, console.log не должен «шуметь».
    spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it('пишет ОДНУ валидную JSON-строку на событие с полями ts, level, msg', () => {
    const log = makeLogger({ LOG_LEVEL: 'info' });
    log.info('привет', { module: 'test' });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('привет');
    expect(parsed.module).toBe('test');
    expect(typeof parsed.ts).toBe('string');
    // ts — валидный ISO-таймстамп.
    expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false);
  });

  it('одна строка не содержит переводов строки внутри (одно событие = одна строка)', () => {
    const log = makeLogger({ LOG_LEVEL: 'info' });
    log.info('многострочный\nтекст');
    expect(lines).toHaveLength(1);
    // Сериализованный \n внутри JSON не считается реальным переводом строки.
    expect(lines[0].split('\n')).toHaveLength(1);
  });

  it('уровни info/warn/error пишутся при пороге info', () => {
    const log = makeLogger({ LOG_LEVEL: 'info' });
    log.info('i');
    log.warn('w');
    log.error('e');
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level);
    expect(levels).toEqual(['info', 'warn', 'error']);
  });

  it('фильтрует события ниже порога LOG_LEVEL (warn → info/debug отбрасываются)', () => {
    const log = makeLogger({ LOG_LEVEL: 'warn' });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    const levels = lines.map((l) => (JSON.parse(l) as { level: string }).level);
    expect(levels).toEqual(['warn', 'error']);
  });

  it('порог error пропускает только error', () => {
    const log = makeLogger({ LOG_LEVEL: 'error' });
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { level: string }).level).toBe('error');
  });

  it('дефолтный порог — info (debug отбрасывается без LOG_LEVEL)', () => {
    const log = makeLogger({});
    log.debug('d');
    log.info('i');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]) as { level: string }).level).toBe('info');
  });

  it('МАСКИРУЕТ секреты в контексте: значение пароля/токена не утекает в вывод', () => {
    const log = makeLogger({ LOG_LEVEL: 'info' });
    const secretPwd = 'sup3r-s3cret-pwd';
    const secretToken = 'tok_abc123XYZ';
    log.info('логин', {
      actor: 'user@example.com',
      password: secretPwd,
      session_token: secretToken,
      nested: { api_secret: 'leak-me-not', visible: 'ok' },
    });

    expect(lines).toHaveLength(1);
    const raw = lines[0];
    // Само значение секрета не должно встречаться в выводе НИ в каком виде.
    expect(raw).not.toContain(secretPwd);
    expect(raw).not.toContain(secretToken);
    expect(raw).not.toContain('leak-me-not');
    // Несекретные поля сохраняются.
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.actor).toBe('user@example.com');
    expect((parsed.nested as Record<string, unknown>).visible).toBe('ok');
    // Сами ключи секретов вырезаны.
    expect(parsed.password).toBeUndefined();
    expect(parsed.session_token).toBeUndefined();
  });

  it('child() добавляет контекст ко ВСЕМ событиям дочернего логгера', () => {
    const log = makeLogger({ LOG_LEVEL: 'info' });
    const child = log.child({ module: 'cdek', requestId: 'req-1' });
    child.info('событие', { action: 'webhook' });

    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.module).toBe('cdek');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.action).toBe('webhook');
  });

  it('child() не мутирует родителя и поля события переопределяют контекст', () => {
    const log = makeLogger({ LOG_LEVEL: 'info' });
    const child = log.child({ module: 'a' });
    child.info('x', { module: 'b' });
    log.info('y');

    const a = JSON.parse(lines[0]) as Record<string, unknown>;
    const b = JSON.parse(lines[1]) as Record<string, unknown>;
    // У дочернего поле события переопределило контекст.
    expect(a.module).toBe('b');
    // У родителя module отсутствует (child не мутировал родителя).
    expect(b.module).toBeUndefined();
  });

  it('LOG_PRETTY=true → человекочитаемый вывод (ветка pretty)', () => {
    const log = makeLogger({ LOG_LEVEL: 'info', LOG_PRETTY: 'true' });
    log.info('привет-pretty', { module: 'm' });
    expect(lines).toHaveLength(1);
    // В pretty-режиме строка содержит уровень и сообщение в читаемом виде.
    expect(lines[0]).toContain('привет-pretty');
    expect(lines[0].toLowerCase()).toContain('info');
  });

  it('formatLine — чистая функция: валидный JSON с заданными полями', () => {
    const line = formatLine(
      { level: 'warn' as LogLevel, msg: 'тест', context: { a: 1 } },
      { pretty: false },
    );
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.level).toBe('warn');
    expect(parsed.msg).toBe('тест');
    expect(parsed.a).toBe(1);
  });

  it('formatLine маскирует секрет и в чистом виде (без логгера)', () => {
    const line = formatLine(
      { level: 'info' as LogLevel, msg: 'm', context: { token: 'XYZ-leak' } },
      { pretty: false },
    );
    expect(line).not.toContain('XYZ-leak');
  });
});
