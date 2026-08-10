import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * СТРАЖ роутов кабинета.
 *
 * Проверяет не поведение отдельного роута, а то, что ни один не выпал из общих
 * правил. Обычные тесты этого не ловят: забытый гейт виден только на том роуте,
 * который забыли покрыть, — то есть ровно там, где никто не смотрит.
 *
 * Правила, за которыми следим:
 *   • каждый роут гейтится модулем `account` — магазин без кабинета не должен
 *     отвечать на эти адреса вовсе;
 *   • каждый читает сессию через общий помощник, а не разбирает заголовки сам —
 *     расхождение реализаций уже дважды приводило к дырам в защите;
 *   • публичные роуты (вход, регистрация, восстановление) перечислены явно,
 *     чтобы «публичным» нельзя было стать по недосмотру.
 */

const ROOT = join(process.cwd(), 'app/api/storefront/v1/account');

/** Роуты, доступные БЕЗ входа — список закрытый и осознанный. */
const PUBLIC_ROUTES = new Set([
  'register/route.ts',      // регистрации сессия не нужна по определению
  'login/route.ts',         // вход её и создаёт
  'logout/route.ts',        // выход обязан работать и с истёкшей сессией
  'verify/route.ts',        // ссылку открывают в другом браузере, где сессии нет
  'password/reset-request/route.ts',  // пароль забыт — войти невозможно
  'password/reset-confirm/route.ts',  // сюда приходят по ссылке из письма
]);

function collectRoutes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectRoutes(full, acc);
    else if (entry === 'route.ts') acc.push(relative(ROOT, full));
  }
  return acc;
}

const routes = collectRoutes(ROOT);

describe('customer/routes — общие правила', () => {
  it('роуты кабинета вообще найдены (иначе тест бесполезен)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
  });

  it.each(routes)('%s гейтится модулем account', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    expect(
      src.includes("module: 'account'"),
      `${rel} не объявляет module: 'account' — магазин без кабинета будет отвечать на этот адрес`,
    ).toBe(true);
  });

  it.each(routes)('%s не разбирает заголовок сессии сам', (rel) => {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    // Заготовка для расхождения: собственный разбор заголовков рано или поздно
    // разойдётся с общей реализацией.
    expect(/headers\.get\(\s*['"]x-customer-session['"]\s*\)/.test(src)).toBe(false);
  });

  it.each(routes.filter((r) => !PUBLIC_ROUTES.has(r)))(
    '%s требует входа',
    (rel) => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(
        src.includes('requireCustomer'),
        `${rel} не требует сессии, хотя не заявлен публичным`,
      ).toBe(true);
    },
  );

  it('список публичных роутов не содержит несуществующих', () => {
    // Иначе переименованный роут тихо выпал бы из проверки «требует входа».
    for (const rel of PUBLIC_ROUTES) {
      expect(routes, `${rel} указан публичным, но такого роута нет`).toContain(rel);
    }
  });
});

describe('customer/routes — доступ к чужим данным', () => {
  it('операции с адресами ограничены владельцем на уровне запроса', () => {
    const src = readFileSync(join(ROOT, 'addresses/[id]/route.ts'), 'utf8');
    // Идентификатор покупателя обязан участвовать в изменении и удалении:
    // проверять принадлежность отдельным запросом — гонка и лишний код.
    expect(src).toContain('who.id');
  });

  it('история заказов передаёт признак подтверждения адреса', () => {
    // Без него в выдачу попали бы гостевые заказы неподтверждённого адреса —
    // то есть чужие покупки.
    const src = readFileSync(join(ROOT, 'orders/route.ts'), 'utf8');
    expect(src).toContain('who.emailVerified');
  });

  it('повторная отправка письма берёт адрес из сессии, а не из тела запроса', () => {
    // Иначе роут стал бы средством рассылки на чужие адреса от имени магазина.
    const src = readFileSync(join(ROOT, 'verify/resend/route.ts'), 'utf8');
    expect(src).toContain('who.email');
    expect(src).not.toContain('req.json()');
  });
});
