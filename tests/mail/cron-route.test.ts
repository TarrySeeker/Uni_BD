import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * Guard cron-роута почты: /api/cron/mail/[task].
 *
 * Проверяем по ИСХОДНИКУ (как tests/gift-certificates/cron.guard.test.ts): роут
 * тянет next/server и БД, исполнять его в юните нельзя, а требования к нему
 * жёсткие и легко теряются при правке.
 *
 * Паритет с расписанием docker-compose сторожит отдельный общий guard
 * (tests/build/cron-crontab-parity.guard.test.ts) — здесь только внутренние
 * требования к самому роуту.
 */

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/mail/[task]/route.ts'), 'utf8');

describe('guard: cron-роут почты', () => {
  it('объявляет задачу retry-failed ЛИТЕРАЛОМ в const TASKS (иначе guard паритета слеп)', () => {
    const m = /const TASKS = \[([^\]]+)\]/.exec(ROUTE);
    expect(m, 'в роуте нет const TASKS = [...]').toBeTruthy();
    expect(m![1]).toContain("'retry-failed'");
  });

  it('защищён общим cron-секретом (extractCronSecret + cronSecretMatches)', () => {
    expect(ROUTE).toContain('extractCronSecret');
    expect(ROUTE).toContain('cronSecretMatches');
  });

  it('без cron-секрета инстанса отвечает 503, а не работает открытым', () => {
    expect(ROUTE).toContain('cron_secret_not_configured');
    expect(ROUTE).toContain('503');
  });

  it('неизвестная задача → 404, неверный ключ → 401', () => {
    expect(ROUTE).toContain('unknown_task');
    expect(ROUTE).toContain('404');
    expect(ROUTE).toContain('unauthorized');
    expect(ROUTE).toContain('401');
  });

  it('незавершённый прогон отдаёт НЕ-2xx (планировщик видит только HTTP-код)', () => {
    expect(ROUTE).toContain('run_incomplete');
    expect(ROUTE).toContain('500');
  });

  it('роут динамический (без кеша ответов планировщику)', () => {
    expect(ROUTE).toContain("dynamic = 'force-dynamic'");
  });

  it('вызывает воркер досылки, а не дублирует его логику в роуте', () => {
    expect(ROUTE).toContain('runRetryFailed');
  });

  it('🔴 роут не логирует тела писем — только имя задачи и статистику', () => {
    expect(ROUTE).not.toMatch(/console\.(log|info)\(/);
  });
});
