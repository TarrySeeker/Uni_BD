/**
 * POST /api/storefront/v1/orders — создание заказа витриной (docs/07 §4.2,
 * ADR-010 anti-tamper). Конвейер: authorizeStorefront → модуль `orders` (иначе
 * 404) → rate-limit → CORS. Транзакция: ре-валидация цен/остатков ИЗ КАТАЛОГА,
 * атомарный резерв, выдача номера, снимок позиций, учёт промокода.
 *
 * Headers: Idempotency-Key (рекоменд.) — повтор не дублирует заказ.
 * Body: { items[], customer:{name,email,phone},
 *         delivery:{type,city?,cityCode?,address?,pvzCode?},
 *         paymentMethod, promoCode?, comment?, idempotencyKey? }
 * delivery.cityCode — числовой код города СДЭК (опц., из автокомплита /cities);
 * персистится в orders.delivery_city_code и используется для to_location
 * курьерки при регистрации накладной (боевой аудит СДЭК 2026-07-09, фикс 4).
 * Ответ: { number, status, paymentStatus, grandTotal, currency, accessToken }.
 * Ошибки: нет остатка → 409; невалидная позиция/промокод → 422.
 */

import {
  runStorefront,
  jsonData,
  jsonError,
  handlePreflight,
  parseJsonBody,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { CreateOrderSchema } from '@/lib/orders/schemas';
import { createOrder } from '@/lib/orders/repository';
import { toOrderCreatedDto, assertOrderTokenConfigured } from '@/lib/storefront/order-dto';
import { normalizeClientIp } from '@/lib/server/request-ip';
import { getCdekConfig } from '@/lib/cdek/config';
import { OrderService, wantsCdekShipmentOnOrder } from '@/lib/cdek/services/order';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';

export const dynamic = 'force-dynamic';

/**
 * Client IP для orders.ip (колонка `inet`, как audit_log).
 *
 * IP ВАЛИДИРУЕТСЯ (normalizeClientIp): X-Forwarded-For / X-Real-IP подконтрольны
 * клиенту/прокси, а сырое значение шло в `inet` — кривой/подделанный заголовок
 * ронял каст и весь INSERT заказа (тот же класс бага, что в auth/action.ts).
 * Невалидный IP → null (колонка nullable).
 */
function clientIp(req: Request): string | null {
  return (
    normalizeClientIp(
      req.headers.get('x-forwarded-for'),
      req.headers.get('x-real-ip'),
    ) ?? null
  );
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const body = await parseJsonBody(req);
      if (!body.ok) {
        return jsonError('bad_request', 'Тело запроса не является валидным JSON.', cors);
      }

      // Idempotency-Key: заголовок имеет приоритет над полем тела (§4.2).
      const headerKey = req.headers.get('idempotency-key')?.trim();
      const raw =
        body.value && typeof body.value === 'object'
          ? { ...(body.value as Record<string, unknown>) }
          : {};
      if (headerKey) {
        raw.idempotencyKey = headerKey;
      }

      const parsed = CreateOrderSchema.safeParse(raw);
      if (!parsed.success) {
        return jsonError(
          'bad_request',
          parsed.error.issues[0]?.message ?? 'Некорректное тело запроса.',
          cors,
        );
      }

      // C7-1: fail-closed ДО createOrder. Иначе при мисконфигурации (в production не
      // задан секрет токена) orderTokenSecret бросил бы в toOrderCreatedDto уже ПОСЛЕ
      // коммита → заказ-сирота в БД + 500 без accessToken. Проверяем заранее тем же env.
      assertOrderTokenConfigured();

      const result = await createOrder(parsed.data, {
        source: 'storefront',
        ip: clientIp(req),
      });

      if (!result.ok) {
        // Нет остатка → 409 conflict; невалидная позиция/промокод → 422.
        if (result.code === 'out_of_stock') {
          return jsonError('conflict', result.message, cors);
        }
        return jsonError('unprocessable', result.message, cors);
      }

      // Накладная ПРИ ЗАКАЗЕ (магазин без онлайн-кассы): при CDEK_CREATE_ON_ORDER
      // регистрируем отправление СДЭК сразу после оформления. Best-effort — сбой
      // НЕ валит ответ заказа (покупатель не виноват в недоступности СДЭК, а
      // недосозданное подхватит cron/оператор в админке). Самовывоз исключён.
      // Идемпотентно: повторный вызов упрётся в advisory-lock и существующее
      // отправление внутри OrderService.createShipment.
      // Повторный idempotency-заказ (reused) уже обрабатывался — не дёргаем СДЭК.
      // Модуль cdek читаем из БД ТОЛЬКО если дешёвые условия прошли (короткое
      // замыкание: иначе лишний запрос настроек на КАЖДОМ заказе даже у магазинов
      // с выключенным режимом; боевой аудит СДЭК 2026-07-09, находка #6).
      const cdekCfg = getCdekConfig();
      const cdekModuleEnabled =
        !result.reused && cdekCfg.createOnOrder && result.order.deliveryType !== 'pickup'
          ? await isModuleEffectivelyEnabled('cdek')
          : false;
      if (
        wantsCdekShipmentOnOrder({
          reused: result.reused,
          createOnOrder: cdekCfg.createOnOrder,
          deliveryType: result.order.deliveryType,
          cdekModuleEnabled,
        })
      ) {
        try {
          await new OrderService().createShipment(result.order.id);
        } catch {
          // Заказ оформлён; накладную довыполнит cron/ручное создание в админке.
        }
      }

      const dto = toOrderCreatedDto(result.order);
      // Повтор с тем же idempotency-ключом → 200 (заказ существует), иначе 201.
      return jsonData(dto, {}, cors, { status: result.reused ? 200 : 201 });
    },
    { module: 'orders', methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
