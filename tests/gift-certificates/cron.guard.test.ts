import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Структурные инварианты крон-догоняльщика сертификатов (проверяются по
 * ИСХОДНИКУ: без живой БД поведение прод-обёртки иначе не зафиксировать).
 *
 * Каждый инвариант сторожит СУТЬ: нужный механизм ЕСТЬ и антипаттерн ЗАПРЕЩЁН.
 */

const ROOT = process.cwd();
const CRON = readFileSync(join(ROOT, 'lib/gift-certificates/cron.ts'), 'utf8');
const ROUTE = readFileSync(join(ROOT, 'app/api/cron/gift/[task]/route.ts'), 'utf8');

describe('guard: lib/gift-certificates/cron.ts', () => {
  it('прогон сериализован транзакционным advisory-lock (два инстанса не топчутся)', () => {
    expect(CRON).toContain('pg_try_advisory_xact_lock');
    expect(CRON).toContain('hashtext');
    // Именно xact-lock: сессионный (pg_try_advisory_lock без _xact) пришлось бы
    // снимать вручную, и при исключении лок повис бы до конца жизни коннекта.
    expect(CRON).not.toMatch(/pg_try_advisory_lock\s*\(/);
    expect(CRON).not.toContain('pg_advisory_unlock');
  });

  it('кандидаты берутся из общей выборки repository, а не переписанным SQL', () => {
    expect(CRON).toContain('findOrdersPendingGiftIssue');
    // Дубль SQL разъехался бы с фильтрами выборки (окно 30 дней, cancelled/refunded).
    expect(CRON).not.toMatch(/FROM\s+orders/i);
  });

  it('выпуск идёт через конвейер автовыпуска (та же идемпотентность, что у вебхука)', () => {
    expect(CRON).toContain('autoIssueGiftsForPaidOrder');
    // Прямой INSERT мимо конвейера обошёл бы настройки и снимки покупателя.
    expect(CRON).not.toMatch(/INSERT\s+INTO/i);
  });

  it('не зависит от модуля СДЭК (модули включаются независимо, мультитенантность)', () => {
    expect(CRON).not.toContain('@/lib/cdek');
  });

  it('никакого хардкода конкретного магазина (платформа мультитенантна)', () => {
    expect(CRON.toLowerCase()).not.toContain('carre');
  });
});

describe('guard: app/api/cron/gift/[task]/route.ts', () => {
  it('секрет берётся общим хелпером с постоянным по времени сравнением', () => {
    expect(ROUTE).toContain('@/lib/cron/secret');
    expect(ROUTE).toContain('cronSecretMatches');
    expect(ROUTE).toContain('extractCronSecret');
    // Наивное сравнение секрета (===) — таймингово уязвимо, запрещено.
    expect(ROUTE).not.toMatch(/provided\s*===\s*/);
  });

  it('без кеша (крон-роут обязан выполняться каждый раз)', () => {
    expect(ROUTE).toContain("export const dynamic = 'force-dynamic'");
  });

  it('детали исключения наружу не отдаются (анти-утечка)', () => {
    expect(ROUTE).toContain('worker_error');
    expect(ROUTE).not.toMatch(/message:\s*(err|message)\b/);
  });
});
