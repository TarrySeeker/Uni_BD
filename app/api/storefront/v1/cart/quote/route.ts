/**
 * POST /api/storefront/v1/cart/quote — серверный расчёт корзины (docs/07 §4.2,
 * ADR-010 anti-tamper). Конвейер: authorizeStorefront → модуль `orders` (иначе
 * 404) → rate-limit → CORS. Ничего НЕ создаёт и НЕ резервирует.
 *
 * Body: { items:[{ variantId|productId, qty }], promoCode?, delivery?:{type,city,pvzCode?} }
 * Цены из тела ИГНОРИРУЮТСЯ — сервер берёт их из каталога (anti-tamper).
 * Ответ: { itemsTotal, discountTotal, deliveryTotal, grandTotal, currency,
 *          lines[], promo, delivery, fulfillable, issues }.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { CartQuoteSchema } from '@/lib/orders/schemas';
import { quoteCart } from '@/lib/orders/repository';
import { toQuoteDto } from '@/lib/storefront/order-dto';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        return jsonError('bad_request', 'Тело запроса не является валидным JSON.', cors);
      }

      const parsed = CartQuoteSchema.safeParse(body.value);
      if (!parsed.success) {
        return jsonError(
          'bad_request',
          parsed.error.issues[0]?.message ?? 'Некорректное тело запроса.',
          cors,
        );
      }

      // Серверный расчёт: цены/остатки из каталога, валидация промокода.
      const result = await quoteCart(parsed.data);

      const dto = toQuoteDto({
        quote: result.quote,
        currency: result.currency,
        fulfillable: result.fulfillable,
        promoReason: result.promo && !result.promo.valid ? result.promo.reason : null,
        issues: result.issues,
        deliveryResolved: result.deliveryResolved,
      });

      return jsonData(dto, {}, cors);
    },
    { module: 'orders', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
