import { describe, it, expect, vi, beforeEach } from 'vitest';

import { hashToken } from '@/lib/customer-auth/token';
import { CUSTOMER_SESSION_TTL_MS } from '@/lib/customer-auth/constants';

/**
 * ЮНИТ (без БД) — хранение токена сессии покупателя ХЕШЕМ (7a security-medium).
 *
 * Прежде customer_sessions.id держал СЫРОЙ токен (утечка дампа → угон сессий).
 * Теперь в БД пишется sha256(raw) — как одноразовые токены (token.ts), а клиенту
 * (cookie/Bearer) уходит сырой токен. Проверяем на моке sql-клиента:
 *   • INSERT кладёт в id именно sha256(возвращённого сырого токена), НЕ сырой;
 *   • validate ищет по sha256(предъявленного сырого токена);
 *   • invalidate (логаут) удаляет по sha256(предъявленного токена).
 */

// Мок sql-клиента: перехватывает tagged-template вызовы, копит текст+значения.
const db = vi.hoisted(() => {
  const calls: { text: string; values: unknown[] }[] = [];
  const state = { calls, selectResult: [] as unknown[] };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join(' ? ') : String(strings);
    calls.push({ text, values });
    if (/SELECT/i.test(text)) return Promise.resolve(state.selectResult);
    return Promise.resolve([]);
  };
  return { calls, state, sql };
});

vi.mock('@/lib/db/client', () => ({ sql: db.sql, closeSql: undefined }));

import {
  createCustomerSession,
  validateCustomerSession,
  invalidateCustomerSession,
} from '@/lib/customer-auth/session';

/** Строка активного покупателя для мока SELECT (все поля mapCustomer + expires_at). */
function activeRow(id: string, email: string): Record<string, unknown> {
  return {
    // Далеко в будущем — чтобы не срабатывало скользящее продление (лишний UPDATE).
    expires_at: new Date(Date.now() + CUSTOMER_SESSION_TTL_MS),
    id,
    email,
    name: 'Покупатель',
    phone: null,
    status: 'active',
    email_verified_at: null,
    last_login_at: null,
    preferred_locale: 'ru',
    orders_count: 0,
    total_spent: '0',
    created_at: new Date('2026-01-01'),
    updated_at: new Date('2026-01-01'),
  };
}

describe('customer-auth/session — хранение хешем', () => {
  beforeEach(() => {
    db.calls.length = 0;
    db.state.selectResult = [];
  });

  it('createCustomerSession: в БД id = sha256(raw), клиенту — сырой токен', async () => {
    const res = await createCustomerSession('cust-1', { ip: '9.9.9.9', userAgent: 'UA' });

    const insert = db.calls.find((c) => /INSERT INTO customer_sessions/i.test(c.text));
    expect(insert).toBeDefined();
    const storedId = insert!.values[0];

    // Сырой токен, отданный клиенту, — base32 (32 символа).
    expect(res.id).toMatch(/^[a-z2-7]{32}$/);
    // В БД лежит sha256(raw) — hex длиной 64, НЕ равный сырому токену.
    expect(storedId).toBe(hashToken(res.id));
    expect(storedId).not.toBe(res.id);
    expect(String(storedId)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validateCustomerSession: лукап по sha256(предъявленного токена)', async () => {
    db.state.selectResult = [activeRow('cust-1', 'buyer@example.io')];
    const raw = 'presentedrawtoken234567abcdefghij';

    const customer = await validateCustomerSession(raw);

    const select = db.calls.find((c) => /FROM\s+customer_sessions/i.test(c.text));
    expect(select).toBeDefined();
    expect(select!.values[0]).toBe(hashToken(raw));
    expect(customer).not.toBeNull();
    expect(customer!.email).toBe('buyer@example.io');
  });

  it('validateCustomerSession: пустой токен → null без запроса к БД', async () => {
    expect(await validateCustomerSession('')).toBeNull();
    expect(db.calls.length).toBe(0);
  });

  it('invalidateCustomerSession: логаут удаляет по sha256(токена)', async () => {
    const raw = 'logoutrawtoken34567abcdefghijklmn';
    await invalidateCustomerSession(raw);

    const del = db.calls.find((c) => /DELETE FROM customer_sessions WHERE id/i.test(c.text));
    expect(del).toBeDefined();
    expect(del!.values[0]).toBe(hashToken(raw));
    expect(del!.values[0]).not.toBe(raw);
  });
});
