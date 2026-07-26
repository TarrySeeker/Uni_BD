import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD: КАЖДЫЙ платёжный провайдер фиксирует ВРЕМЯ ИНИЦИАЦИИ платежа.
 *
 * ДЕФЕКТ (регрессия правки страницы успеха): «покупатель заплатил и вернулся
 * раньше вебхука» витрина отличала от «не платил вовсе» ТОЛЬКО по `?paid=1` —
 * параметру, который ставит исключительно наш mock. Боевые шлюзы его не шлют,
 * и покупатель видел кнопку «оплатить» поверх уже прошедшего платежа.
 *
 * Правило: единственный честный сигнал — серверный факт
 * `orders.payment_initiated_at` (миграция 0058), и он обязан проставляться там же,
 * где сохраняется `payment_ref`, — у ВСЕХ провайдеров. Провайдер, который об этом
 * забудет, вернёт покупателям возможность заплатить дважды, поэтому проверяем
 * КАТАЛОГ провайдеров целиком, а не заранее известную тройку: новый адаптер
 * (lib/payments/<провайдер>/repository.ts) попадёт под тот же гард автоматически.
 *
 * Мультитенантность: правило про ЛЮБОЙ эквайринг платформы, а не про магазин.
 */

const ROOT = resolve(__dirname, '../..');
const PAYMENTS = resolve(ROOT, 'lib/payments');
const read = (p: string): string => readFileSync(p, 'utf8');

/** Репозитории всех провайдеров, которые сохраняют ссылку на платёж. */
function providerRepositories(): Array<{ provider: string; src: string }> {
  return readdirSync(PAYMENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ provider: e.name, file: resolve(PAYMENTS, e.name, 'repository.ts') }))
    .filter((x) => {
      try {
        return read(x.file).includes('payment_ref =');
      } catch {
        return false;
      }
    })
    .map((x) => ({ provider: x.provider, src: read(x.file) }));
}

describe('время инициации платежа фиксируют все провайдеры', () => {
  const repos = providerRepositories();

  it('провайдеры вообще найдены (иначе гард молча ничего не проверяет)', () => {
    expect(repos.length).toBeGreaterThanOrEqual(3);
  });

  for (const { provider, src } of repos) {
    it(`🔴 ${provider}: UPDATE с payment_ref ставит и payment_initiated_at`, () => {
      // Берём каждый UPDATE, который ПИШЕТ payment_ref (не читает его в WHERE),
      // и требуем в нём же отметку времени: иначе окно «подтверждение в пути»
      // не с чего отсчитывать.
      const updates = src
        .split('UPDATE orders')
        .slice(1)
        .map((chunk) => chunk.slice(0, chunk.indexOf('`')))
        .filter((stmt) => /SET[\s\S]*payment_ref\s*=/.test(stmt));
      expect(updates.length, `${provider}: UPDATE payment_ref не найден`).toBeGreaterThan(0);
      for (const stmt of updates) {
        expect(stmt, `${provider}: payment_initiated_at не проставлен`).toMatch(
          /payment_initiated_at\s*=\s*now\(\)/,
        );
      }
    });
  }
});

describe('миграция 0058 — колонка аддитивна', () => {
  // Без `--`-комментариев: слова DROP/RENAME встречаются в шапке-обосновании.
  const sql = read(resolve(ROOT, 'db/migrations/0058_orders_payment_initiated_at.sql'))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

  it('ADD COLUMN IF NOT EXISTS, без DROP/RENAME', () => {
    expect(sql).toMatch(/ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_initiated_at\s+timestamptz/);
    expect(sql).not.toMatch(/\bDROP\b|\bRENAME\b/i);
  });

  it('колонка nullable — старые заказы не блокируются', () => {
    expect(sql).not.toMatch(/payment_initiated_at[^;]*NOT NULL/i);
  });
});
