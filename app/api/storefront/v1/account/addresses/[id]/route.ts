/**
 * PATCH  /api/storefront/v1/account/addresses/:id — правка адреса.
 * DELETE /api/storefront/v1/account/addresses/:id — удаление адреса.
 *
 * Принадлежность проверяется НЕ отдельным запросом, а условием внутри изменения:
 * идентификатор покупателя входит в `WHERE`. Проверить-а-потом-изменить было бы
 * гонкой, а главное — лишним кодом, который легко забыть в одном из роутов.
 * Чужой адрес просто «не находится»: ответ тот же, что и для несуществующего.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { AddressSchema } from '@/lib/customer/schemas';
import { updateAddress, deleteAddress } from '@/lib/customer/repository';
import { ACCOUNT_METHODS, requireCustomer } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function PATCH(req: Request, { params }: Params): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      const { id } = await params;

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

      const address = await updateAddress(id, who.id, parsed.data);
      if (!address) {
        return jsonError('not_found', 'Адрес не найден.', cors);
      }

      return jsonData({ address }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}

export async function DELETE(req: Request, { params }: Params): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      const { id } = await params;
      const removed = await deleteAddress(id, who.id);
      if (!removed) {
        return jsonError('not_found', 'Адрес не найден.', cors);
      }

      return jsonData({ ok: true }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
