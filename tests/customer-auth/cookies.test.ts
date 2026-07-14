import { describe, expect, it } from 'vitest';

import { extractCustomerSessionToken } from '@/lib/customer-auth/cookies';
import { CUSTOMER_SESSION_COOKIE_NAME } from '@/lib/customer-auth/constants';

/**
 * ЮНИТ — извлечение токена сессии (docs/24 §6). Приоритет Bearer → cookie.
 * Чистая функция (только заголовки Request), без next/headers.
 */
function reqWith(headers: Record<string, string>): Request {
  return new Request('https://shop.example/api', { headers });
}

describe('customer-auth/cookies — extractCustomerSessionToken', () => {
  it('читает Bearer-токен', () => {
    const req = reqWith({ authorization: 'Bearer abc123token' });
    expect(extractCustomerSessionToken(req)).toBe('abc123token');
  });

  it('Bearer имеет приоритет над cookie', () => {
    const req = reqWith({
      authorization: 'Bearer from-bearer',
      cookie: `${CUSTOMER_SESSION_COOKIE_NAME}=from-cookie`,
    });
    expect(extractCustomerSessionToken(req)).toBe('from-bearer');
  });

  it('читает cookie, когда Bearer нет', () => {
    const req = reqWith({
      cookie: `other=x; ${CUSTOMER_SESSION_COOKIE_NAME}=sesscookie; foo=bar`,
    });
    expect(extractCustomerSessionToken(req)).toBe('sesscookie');
  });

  it('игнорирует чужую (admin) cookie admik_session', () => {
    const req = reqWith({ cookie: 'admik_session=adminsess' });
    expect(extractCustomerSessionToken(req)).toBeNull();
  });

  it('нет ни Bearer, ни cookie → null', () => {
    expect(extractCustomerSessionToken(reqWith({}))).toBeNull();
  });

  it('пустой Bearer → null', () => {
    expect(extractCustomerSessionToken(reqWith({ authorization: 'Bearer ' }))).toBeNull();
  });
});
