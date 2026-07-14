/**
 * Общие хелперы роутов /account/* (docs/24 §6). НЕ route.ts → Next не считает
 * файл роутом (имя с префиксом _).
 *
 * Транспорт сессии (ASSUMED, решение владельца §11): на login/register ставим
 * httpOnly-cookie `admik_customer_session` (same-site поток) И возвращаем
 * sessionToken в теле (Bearer-поток для кросс-домена). Оба поддерживаются, чтобы
 * доменная схема витрины (один домен vs кросс-домен) выбиралась без правок кода.
 */

import { NextResponse } from 'next/server';
import { normalizeClientIp } from '@/lib/server/request-ip';
import { setCustomerSessionCookie } from '@/lib/customer-auth/cookies';
import { toCustomerMeDto } from '@/lib/storefront/account-dto';
import type { AuthResult, SessionMeta } from '@/lib/customer-auth/types';

/** Метаданные запроса для сессии/rate-limit (валидированный ip + user-agent). */
export function reqMeta(req: Request): SessionMeta {
  return {
    ip: normalizeClientIp(
      req.headers.get('x-forwarded-for'),
      req.headers.get('x-real-ip'),
    ),
    userAgent: req.headers.get('user-agent'),
  };
}

/**
 * Единый успешный ответ аутентификации: ставит cookie и возвращает
 * { data: { customer, sessionToken, expiresAt } } с CORS-заголовками.
 * sessionToken — сырой токен сессии (для Bearer-потока), НЕ логируется.
 */
export async function authResponse(
  result: AuthResult,
  cors: Record<string, string>,
  status: number,
): Promise<NextResponse> {
  await setCustomerSessionCookie(result.sessionToken, result.expiresAt);
  return NextResponse.json(
    {
      data: {
        customer: toCustomerMeDto(result.customer),
        sessionToken: result.sessionToken,
        expiresAt: result.expiresAt.toISOString(),
      },
    },
    { status, headers: cors },
  );
}
