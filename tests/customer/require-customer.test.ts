import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Определение покупателя по заголовкам.
 *
 * Проверяем ровно одно: токен берётся из заголовка и передаётся на проверку без
 * искажений, а любая неопределённость трактуется как «вход не выполнен».
 */

const validate = vi.hoisted(() => vi.fn());
vi.mock('@/lib/customer/session', () => ({ validateCustomerSession: validate }));

import {
  extractCustomerSessionToken,
  getCustomerFromHeaders,
} from '@/lib/customer/require-customer';
import { CUSTOMER_SESSION_HEADER } from '@/lib/customer/constants';

const CUSTOMER = {
  id: 'cust-1',
  email: 'buyer@example.com',
  name: 'Имя',
  phone: null,
  emailVerified: true,
};

beforeEach(() => {
  validate.mockReset();
  validate.mockResolvedValue(CUSTOMER);
});

describe('customer/require-customer — извлечение токена', () => {
  it('берёт значение из условленного заголовка', () => {
    const headers = new Headers({ [CUSTOMER_SESSION_HEADER]: 'token-abc' });
    expect(extractCustomerSessionToken(headers)).toBe('token-abc');
  });

  it('обрезает пробелы вокруг значения', () => {
    const headers = new Headers({ [CUSTOMER_SESSION_HEADER]: '  token-abc  ' });
    expect(extractCustomerSessionToken(headers)).toBe('token-abc');
  });

  it('заголовка нет → null', () => {
    expect(extractCustomerSessionToken(new Headers())).toBeNull();
  });

  it('заголовок из одних пробелов → null, а не пустая строка', () => {
    // Иначе на проверку ушёл бы пустой токен, и отказ пришёл бы уже из базы —
    // лишний запрос на каждый анонимный визит.
    const headers = new Headers({ [CUSTOMER_SESSION_HEADER]: '   ' });
    expect(extractCustomerSessionToken(headers)).toBeNull();
  });
});

describe('customer/require-customer — определение покупателя', () => {
  it('действующая сессия возвращает покупателя', async () => {
    const headers = new Headers({ [CUSTOMER_SESSION_HEADER]: 'token-abc' });
    await expect(getCustomerFromHeaders(headers)).resolves.toEqual(CUSTOMER);
    expect(validate).toHaveBeenCalledWith('token-abc');
  });

  it('без заголовка проверка сессии вообще не вызывается', async () => {
    await expect(getCustomerFromHeaders(new Headers())).resolves.toBeNull();
    expect(validate).not.toHaveBeenCalled();
  });

  it('неизвестный или истёкший токен → null', async () => {
    validate.mockResolvedValue(null);
    // Значение латиницей: заголовки HTTP не принимают символы вне ASCII.
    const headers = new Headers({ [CUSTOMER_SESSION_HEADER]: 'expired-token' });
    await expect(getCustomerFromHeaders(headers)).resolves.toBeNull();
  });
});
