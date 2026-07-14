/**
 * POST /api/storefront/v1/account/logout — выход покупателя (docs/24 §6).
 *
 * Инвалидирует текущую сессию (по Bearer ИЛИ cookie) и чистит cookie. Идемпотентно
 * (нет токена → всё равно 204). Гейт module:'account'.
 */

import { NextResponse } from 'next/server';
import {
  runStorefront,
  handlePreflight,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { extractCustomerSessionToken, clearCustomerSessionCookie } from '@/lib/customer-auth/cookies';
import { logout } from '@/lib/customer-auth/service';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const token = extractCustomerSessionToken(req);
      await logout(token);
      await clearCustomerSessionCookie();
      return new NextResponse(null, { status: 204, headers: cors });
    },
    { module: 'account', methods: STOREFRONT_WRITE_METHODS, credentialed: true },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS, true);
}
