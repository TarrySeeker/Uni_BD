/**
 * GET  /api/storefront/v1/account/addresses — адресная книга покупателя.
 * POST /api/storefront/v1/account/addresses — новый адрес.
 *
 * Покупатель определяется по сессии, а не по телу запроса: иначе можно было бы
 * записать адрес в чужую книгу, указав чужой идентификатор.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { AddressSchema } from '@/lib/customer/schemas';
import { listAddresses, createAddress } from '@/lib/customer/repository';
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
      return jsonData({ addresses: await listAddresses(who.id) }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}

export async function POST(req: Request): Promise<Response> {
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

      const parsed = AddressSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError('unprocessable', 'Проверьте поля адреса.', cors);
      }

      const address = await createAddress(who.id, parsed.data);
      return jsonData({ address }, {}, cors, { status: 201 });
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
