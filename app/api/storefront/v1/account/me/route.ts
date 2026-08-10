/**
 * GET   /api/storefront/v1/account/me — данные текущего покупателя.
 * PATCH /api/storefront/v1/account/me — правка профиля (имя, телефон).
 *
 * Наружу отдаётся только то, что нужно витрине. Внутренний идентификатор
 * покупателя в ответ не попадает: он не нужен ни одной странице кабинета, а
 * лишнее поле в публичном ответе — лишняя поверхность.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { ProfileSchema } from '@/lib/customer/schemas';
import { updateProfile } from '@/lib/customer/repository';
import { ACCOUNT_METHODS, requireCustomer } from '@/lib/customer/route-helpers';
import type { CustomerAuth } from '@/lib/customer/types';

export const dynamic = 'force-dynamic';

/** Публичное представление покупателя — без внутреннего идентификатора. */
function toPublic(customer: CustomerAuth) {
  return {
    email: customer.email,
    name: customer.name,
    phone: customer.phone,
    emailVerified: customer.emailVerified,
  };
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;
      return jsonData({ customer: toPublic(who) }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}

export async function PATCH(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }

      const parsed = ProfileSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля формы.', cors);
      }

      // Адрес почты здесь не меняется намеренно: смена адреса требует
      // подтверждения нового и отзыва подтверждения старого, иначе через профиль
      // можно было бы «переехать» на чужой адрес и забрать его гостевые заказы.
      await updateProfile(who.id, parsed.data);

      return jsonData(
        { customer: toPublic({ ...who, name: parsed.data.name, phone: parsed.data.phone || null }) },
        {},
        cors,
      );
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
