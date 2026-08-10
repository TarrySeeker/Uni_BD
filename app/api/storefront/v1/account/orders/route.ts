/**
 * GET /api/storefront/v1/account/orders — история заказов покупателя.
 *
 * 🔴 Заказы, оформленные ранее ГОСТЕМ на тот же адрес почты, попадают в выдачу
 * только при подтверждённом адресе — признак берётся из сессии и передаётся в
 * запрос. Иначе достаточно зарегистрироваться на чужой email, чтобы увидеть
 * чужие покупки с адресами доставки и телефонами.
 *
 * Свои заказы (привязанные при оформлении из кабинета) видны всегда: там
 * подтверждение адреса ни при чём.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { listCustomerOrders } from '@/lib/customer/repository';
import { ACCOUNT_METHODS, requireCustomer } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      const orders = await listCustomerOrders(who.id, who.email, who.emailVerified);

      return jsonData(
        { orders },
        // Признак пригодится витрине: пока адрес не подтверждён, уместно
        // показать напоминание, что часть заказов может быть не видна.
        { emailVerified: who.emailVerified },
        cors,
      );
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
