import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Сессии покупателя. Проверяем поведение, а не запросы: БД подменена, важно
 * КАКОЕ решение принимается и ЧТО уходит в базу.
 *
 * Главное свойство: в базу уходит ХЕШ токена, а наружу отдаётся сырой токен.
 * Сырой в базе не появляется никогда — иначе дамп, лог запроса или доступ
 * «только на чтение» давали бы готовый набор действующих сессий.
 */

/** Перехватывает выполненные запросы: [строки шаблона, ...подставленные значения]. */
const queries = vi.hoisted(() => [] as { text: string; values: unknown[] }[]);
const nextRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('@/lib/db/client', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join('?'), values });
    return Promise.resolve(nextRows.value);
  },
}));

import {
  createCustomerSession,
  validateCustomerSession,
  invalidateCustomerSession,
  invalidateCustomerSessions,
} from '@/lib/customer/session';
import { hashToken } from '@/lib/customer/token';
import { CUSTOMER_SESSION_TTL_MS } from '@/lib/customer/constants';

/** Строка «сессия + покупатель», как её отдаёт объединяющий запрос. */
function sessionRow(over: Record<string, unknown> = {}) {
  return {
    customer_id: 'cust-1',
    expires_at: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
    status: 'active',
    email: 'buyer@example.com',
    name: 'Покупатель',
    phone: null,
    email_verified_at: new Date(),
    ...over,
  };
}

beforeEach(() => {
  queries.length = 0;
  nextRows.value = [];
});

describe('customer/session — создание', () => {
  it('в базу уходит ХЕШ токена, а вызывающему отдаётся сырой', async () => {
    const { token } = await createCustomerSession('cust-1');

    const insert = queries.find((q) => q.text.includes('INSERT INTO customer_sessions'));
    expect(insert).toBeDefined();
    // Именно это и защищает от угона сессий по дампу базы.
    expect(insert!.values).toContain(hashToken(token));
    expect(insert!.values).not.toContain(token);
  });

  it('каждый вызов даёт новый непредсказуемый токен', async () => {
    const a = await createCustomerSession('cust-1');
    const b = await createCustomerSession('cust-1');
    expect(a.token).not.toBe(b.token);
  });

  it('срок жизни выставляется на 30 дней вперёд', async () => {
    const before = Date.now();
    const { expiresAt } = await createCustomerSession('cust-1');
    const planned = expiresAt.getTime() - before;
    expect(planned).toBeGreaterThan(CUSTOMER_SESSION_TTL_MS - 5_000);
    expect(planned).toBeLessThanOrEqual(CUSTOMER_SESSION_TTL_MS + 5_000);
  });

  it('адрес и браузер сохраняются для диагностики', async () => {
    await createCustomerSession('cust-1', { ip: '203.0.113.7', userAgent: 'Firefox' });
    const insert = queries.find((q) => q.text.includes('INSERT INTO customer_sessions'));
    expect(insert!.values).toContain('203.0.113.7');
    expect(insert!.values).toContain('Firefox');
  });
});

describe('customer/session — проверка', () => {
  it('ищет по ХЕШУ пришедшего токена, а не по нему самому', async () => {
    nextRows.value = [sessionRow()];
    await validateCustomerSession('raw-token-from-cookie');

    const select = queries.find((q) => q.text.includes('FROM customer_sessions'));
    expect(select!.values).toContain(hashToken('raw-token-from-cookie'));
    expect(select!.values).not.toContain('raw-token-from-cookie');
  });

  it('неизвестный токен → null', async () => {
    nextRows.value = [];
    expect(await validateCustomerSession('нет такого')).toBeNull();
  });

  it('просроченная сессия → null И удаляется', async () => {
    nextRows.value = [sessionRow({ expires_at: new Date(Date.now() - 1000) })];
    expect(await validateCustomerSession('t')).toBeNull();
    expect(queries.some((q) => q.text.includes('DELETE FROM customer_sessions'))).toBe(true);
  });

  it('заблокированный покупатель → null даже при живой сессии', async () => {
    // Блокировка из админки обязана действовать немедленно, а не после
    // истечения тридцатидневной сессии.
    nextRows.value = [sessionRow({ status: 'disabled' })];
    expect(await validateCustomerSession('t')).toBeNull();
  });

  it('гость (пароля нет) не может иметь действующей сессии', async () => {
    nextRows.value = [sessionRow({ status: 'guest' })];
    expect(await validateCustomerSession('t')).toBeNull();
  });

  it('действующая сессия возвращает покупателя без внутренних полей', async () => {
    nextRows.value = [sessionRow()];
    const who = await validateCustomerSession('t');
    expect(who).toEqual({
      id: 'cust-1',
      email: 'buyer@example.com',
      name: 'Покупатель',
      phone: null,
      emailVerified: true,
    });
  });

  it('неподтверждённый адрес отражается в признаке, а не блокирует вход', async () => {
    // Войти можно, но гостевые заказы по совпадению адреса ещё не показываются.
    nextRows.value = [sessionRow({ email_verified_at: null })];
    const who = await validateCustomerSession('t');
    expect(who?.emailVerified).toBe(false);
  });
});

describe('customer/session — продление', () => {
  it('свежая сессия НЕ продлевается: продление — это запись в базу', async () => {
    nextRows.value = [sessionRow({ expires_at: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS) })];
    await validateCustomerSession('t');
    expect(queries.some((q) => q.text.includes('UPDATE customer_sessions'))).toBe(false);
  });

  it('сессия на исходе продлевается — активный покупатель не разлогинивается', async () => {
    nextRows.value = [sessionRow({ expires_at: new Date(Date.now() + 60_000) })];
    await validateCustomerSession('t');
    expect(queries.some((q) => q.text.includes('UPDATE customer_sessions'))).toBe(true);
  });
});

describe('customer/session — завершение', () => {
  it('выход удаляет сессию по хешу токена', async () => {
    await invalidateCustomerSession('raw');
    const del = queries.find((q) => q.text.includes('DELETE FROM customer_sessions'));
    expect(del!.values).toContain(hashToken('raw'));
  });

  it('смена пароля закрывает ВСЕ сессии покупателя', async () => {
    // Если пароль сменили из-за утечки, старая сессия злоумышленника не должна
    // пережить смену.
    await invalidateCustomerSessions('cust-1');
    const del = queries.find((q) => q.text.includes('DELETE FROM customer_sessions'));
    expect(del!.values).toContain('cust-1');
  });
});
