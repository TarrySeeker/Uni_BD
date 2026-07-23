/**
 * GET /api/storefront/v1/orders/:number/gift-codes — коды подарочных
 * сертификатов, ВЫПУЩЕННЫХ по заказу (ТЗ владельца п.11).
 *
 * 🔴 Отдельный эндпоинт, а не поле в OrderPublicDto: код — деньги на
 * предъявителя, у него другой периметр доступа и другой режим кеширования.
 *
 * Периметр:
 *  - ТОЛЬКО ?token= (accessToken заказа). Email-путь verifyOrderAccess здесь
 *    ЗАПРЕЩЁН (allowEmail:false): номера заказов последовательны, а email
 *    покупателей известен — для трекинга это приемлемо, для денег нет;
 *  - код отдаётся лишь при payment_status='paid' и status ∉ cancelled/refunded
 *    (решает buildGiftCodesPayload);
 *  - собственное жёсткое ведро rate-limit (общий 600/мин на IP для перебора мал);
 *  - Cache-Control: no-store на ЛЮБОМ ответе;
 *  - код НИКОГДА не пишется в логи.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { getOrderByNumber } from '@/lib/orders/repository';
import { verifyOrderAccess } from '@/lib/storefront/order-dto';
import {
  buildGiftCodesPayload,
  checkGiftCodesRate,
  giftCodesRateKeyFromRequest,
  registerGiftCodesHit,
} from '@/lib/storefront/gift-order-codes';
import { listGiftCertificatesIssuedForOrder } from '@/lib/gift-certificates/repository';
import { getSetting } from '@/lib/settings/repository';
import { resolveGiftSettings } from '@/lib/settings/schemas';

export const dynamic = 'force-dynamic';

/** Ключ настроек магазина с параметрами сертификатов. */
const GIFT_SETTINGS_KEY = 'gift';

/** Заголовки ответа: код не должен осесть ни в одном кеше по пути. */
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ number: string }> },
): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const headers = { ...cors, ...NO_STORE };
      const { number } = await ctx.params;
      const url = new URL(req.url);
      const token = url.searchParams.get('token');

      // Жёсткое ведро именно этого эндпоинта — ДО обращения к БД.
      const rateKey = giftCodesRateKeyFromRequest(req.headers);
      const rate = await checkGiftCodesRate(rateKey);
      if (!rate.allowed) {
        return jsonError('rate_limited', 'Слишком много запросов.', headers, {
          'Retry-After': String(rate.retryAfterSec ?? 60),
        });
      }
      await registerGiftCodesHit(rateKey);

      const found = await getOrderByNumber(number);
      // Единый 404 для «нет заказа» и «нет доступа»: перебор не должен различать.
      if (!found || !verifyOrderAccess(found.order, { token }, process.env, { allowEmail: false })) {
        return jsonError('not_found', 'Заказ не найден.', headers);
      }

      const [certificates, giftSetting] = await Promise.all([
        listGiftCertificatesIssuedForOrder(found.order.id),
        getSetting(GIFT_SETTINGS_KEY),
      ]);

      const payload = buildGiftCodesPayload({
        order: found.order,
        items: found.items,
        certificates,
        settings: resolveGiftSettings(giftSetting?.value),
      });

      return jsonData(payload, {}, headers);
    },
    { module: 'orders' },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
