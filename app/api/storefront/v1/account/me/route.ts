/**
 * GET /api/storefront/v1/account/me — текущий покупатель (docs/24 §6).
 * PATCH — частичное обновление профиля (name/phone/preferredLocale).
 *
 * Нет валидной сессии → 401. Гейт module:'account'. DTO без id/секретов/таймстампов.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { extractCustomerSessionToken } from '@/lib/customer-auth/cookies';
import { getMe, updateProfile } from '@/lib/customer-auth/service';
import { ProfileUpdateSchema } from '@/lib/customer-auth/schemas';
import { toCustomerMeDto } from '@/lib/storefront/account-dto';

export const dynamic = 'force-dynamic';

const METHODS = 'GET, PATCH, OPTIONS';

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const customer = await getMe(extractCustomerSessionToken(req));
      if (!customer) {
        return jsonError('unauthorized', 'Требуется вход.', cors);
      }
      return jsonData(toCustomerMeDto(customer), {}, cors);
    },
    { module: 'account', methods: METHODS, credentialed: true },
  );
}

export async function PATCH(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors, locale }) => {
      const customer = await getMe(extractCustomerSessionToken(req));
      if (!customer) {
        return jsonError('unauthorized', 'Требуется вход.', cors);
      }
      const parsedBody = await parseJsonBody(req);
      if (!parsedBody.ok) {
        return jsonError('bad_request', 'Тело запроса не является JSON.', cors);
      }
      const parsed = ProfileUpdateSchema.safeParse(parsedBody.value);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля профиля.', cors);
      }
      const updated = await updateProfile(customer.id, {
        name: parsed.data.name ?? undefined,
        phone: parsed.data.phone ?? undefined,
        preferredLocale: parsed.data.preferredLocale ?? undefined,
      });
      if (!updated) {
        return jsonError('unauthorized', 'Требуется вход.', cors);
      }
      // locale-контекст запроса не влияет на профиль (PII не локализуется), но
      // остаётся доступен для будущих транзакционных писем на нужном языке.
      void locale;
      return jsonData(toCustomerMeDto(updated), {}, cors);
    },
    { module: 'account', methods: METHODS, credentialed: true },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, METHODS, true);
}
