/**
 * POST /api/payments/ozon/webhook — приём POST-уведомлений Ozon Acquiring
 * (порт роута payments/tbank/webhook).
 *
 * Server-to-server роут (Ozon → наш сервер): без runStorefront и без CORS.
 *
 * Защита:
 *   1) module-gate: модуль payments выключен → 404;
 *   2) ГЛАВНОЕ — проверка подписи requestSign ключом нотификаций
 *      (OZON_PAY_NOTIFICATION_SECRET). Неверная подпись → 403, не обрабатываем.
 *      Ключ нотификаций отдельный от секретного ключа запросов: если он не задан,
 *      уведомления отвергаются целиком — принимать их «на веру» нельзя, иначе
 *      кто угодно пометит заказ оплаченным;
 *   3) идемпотентная обработка по (transaction_uid, status).
 *
 * Коды ответа. На успешно проверенном уведомлении при любом штатном исходе
 * (в том числе повтор, неизвестный заказ, немаппящийся статус) отвечаем 200,
 * чтобы Ozon не ретраил бесконечно. НЕОЖИДАННАЯ ошибка обработки → 500: пусть
 * банк повторит, обработка атомарна и повтор безопасен.
 *
 * GET — проверка доступности эндпоинта (Ozon и админ могут его «пинговать»).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { OzonPaymentService, parseNotification } from '@/lib/payments/ozon/service';
import { canVerifyOzonNotifications } from '@/lib/payments/ozon/config';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'ozon.webhook' });

export const dynamic = 'force-dynamic';

/** Короткий ответ об успехе. */
function ok(): NextResponse {
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * IP источника — только для журнала, не для аутентификации.
 * X-Forwarded-For задаётся клиентом и подделывается, поэтому решение
 * «принять или отвергнуть» принимает исключительно проверка подписи.
 */
function extractIp(req: NextRequest): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('x-real-ip');
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return new NextResponse('Not Found', { status: 404 });
  }

  // Без ключа нотификаций проверить подпись нечем — принимать нельзя.
  if (!canVerifyOzonNotifications()) {
    log.error('ozon.webhook: OZON_PAY_NOTIFICATION_SECRET не задан — уведомление отвергнуто');
    return new NextResponse('Forbidden', { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const notification = parseNotification(raw);
  if (!notification) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const service = new OzonPaymentService();
  const ip = extractIp(req);

  let result;
  try {
    result = await service.handleNotification(notification, { ip });
  } catch (e) {
    // Неожиданный сбой обработки проверенного события: отвечаем 500, чтобы Ozon
    // повторил доставку. Запись журнала и смена статуса атомарны, поэтому
    // повтор безопасно доведёт дело до конца.
    log.error('ozon.webhook: сбой обработки уведомления', {
      error: e instanceof Error ? e.message : String(e),
    });
    return new NextResponse('Internal Server Error', { status: 500 });
  }

  if (!result.accepted) {
    log.warn('ozon.webhook: неверная подпись уведомления — отклонено', {
      ip,
      extOrderID: notification.extOrderID ?? null,
    });
    return new NextResponse('Forbidden', { status: 403 });
  }

  log.info('ozon.webhook: уведомление обработано', {
    extOrderID: notification.extOrderID ?? null,
    status: notification.status ?? null,
    paymentMethod: notification.paymentMethod ?? null,
    testMode: notification.testMode ?? null,
    inserted: result.inserted,
    processed: result.processed,
    reason: result.reason ?? null,
  });

  return ok();
}

/** Проверка доступности эндпоинта. Уведомления не обрабатывает. */
export async function GET(): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return NextResponse.json({ ok: true, provider: 'ozon' });
}
