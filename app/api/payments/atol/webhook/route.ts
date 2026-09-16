/**
 * POST /api/payments/atol/webhook — приём callback АТОЛ Pay Ecom
 * (порт роута payments/ozon/webhook, но с другой моделью аутентификации).
 *
 * Server-to-server роут (АТОЛ → наш сервер): без runStorefront и без CORS.
 *
 * 🔴 ГЛАВНОЕ ОТЛИЧИЕ ОТ Т-БАНКА И ОЗОНА: у callback АТОЛа НЕТ ПОДПИСИ — ни
 * HMAC, ни секрета уведомлений, ни контрольной суммы (docs-atol/02). Пересчитать
 * нечего, поэтому защита строится из двух слоёв, и ни один из них здесь не
 * лишний:
 *
 *   1) СЕКРЕТ В QUERY (этот роут). Документация разрешает произвольные
 *      query-параметры в notificationUrl — это единственный канал
 *      аутентификации, который даёт API. Слабое место: секрет уходит в
 *      открытом URL и оседает в логах прокси, поэтому он НЕ может быть
 *      единственной защитой;
 *   2) СВЕРКА ЧЕРЕЗ API (service.handleCallback). Тело callback трактуется
 *      лишь как сигнал «сходи проверь»; статус заказа меняется ТОЛЬКО по
 *      ответу GET /payments/{orderId}/status, запрошенному нами по токену.
 *      Этот слой работает даже при утёкшем секрете.
 *
 * 🔴 ПОЭТОМУ РОУТ НЕ ЧИТАЕТ `paymentStatus` ИЗ ТЕЛА и ничего по нему не решает.
 * Если бы читал, кто угодно, узнав URL и секрет, объявил бы заказ оплаченным
 * одним curl'ом — а вся идея второго слоя в том, что подделанное тело не даёт
 * подделать ответ API.
 *
 * Порядок проверок (как у Озона):
 *   1) module-gate: модуль payments выключен → 404;
 *   2) нечем проверять (секрет не настроен или слишком короткий) → 403 и
 *      отвергаем ВСЁ: принимать уведомления «на веру» нельзя;
 *   3) неверный секрет → 403;
 *   4) неразобранное тело → 400;
 *   5) дальше решает сервис.
 *
 * Коды ответа. На аутентифицированном вебхуке при любом ШТАТНОМ исходе (повтор,
 * неизвестный заказ, немаппящийся статус) отвечаем 200, чтобы АТОЛ не ретраил
 * бесконечно. НЕОЖИДАННАЯ ошибка обработки → 500: пусть повторит, обработка
 * атомарна и повтор безопасен.
 *
 * GET — проверка доступности эндпоинта (можно «пинговать» из админки).
 */

import { NextResponse, type NextRequest } from 'next/server';

import { AtolPaymentService } from '@/lib/payments/atol/service';
import { parseCallback, verifyCallbackSecret, CALLBACK_SECRET_PARAM } from '@/lib/payments/atol/callback';
import { canVerifyAtolCallbacks, getAtolConfig } from '@/lib/payments/atol/config';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'atol.webhook' });

export const dynamic = 'force-dynamic';

/** Короткий ответ об успехе. */
function ok(): NextResponse {
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * IP источника — ТОЛЬКО для журнала, не для аутентификации.
 * X-Forwarded-For задаётся клиентом и подделывается; допускать его до решения
 * «принять или отвергнуть» — значит заменить проверку секрета на самообман.
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

  // Подписи у АТОЛа нет: без настроенного (и достаточно длинного) секрета
  // проверить отправителя нечем вовсе — отвергаем ВСЁ. Это не паранойя:
  // принимая такие callback, магазин раздаёт право помечать заказы оплаченными
  // любому, кто узнал URL.
  if (!canVerifyAtolCallbacks()) {
    log.error(
      'atol.webhook: ATOL_PAY_NOTIFICATION_SECRET не задан или короче минимума — callback отвергнут',
    );
    return new NextResponse('Forbidden', { status: 403 });
  }

  const ip = extractIp(req);

  const cfg = getAtolConfig();
  const provided = req.nextUrl.searchParams.get(CALLBACK_SECRET_PARAM);
  if (!verifyCallbackSecret(provided, cfg.notificationSecret)) {
    // Секрет не логируем даже частично: он и так утекает в логи прокси через URL,
    // дублировать утечку в журнал приложения незачем.
    log.warn('atol.webhook: неверный секрет в query — callback отклонён', { ip });
    return new NextResponse('Forbidden', { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const callback = parseCallback(raw);
  if (!callback) {
    return new NextResponse('Bad Request', { status: 400 });
  }

  const service = new AtolPaymentService();

  let result;
  try {
    result = await service.handleCallback(callback, { ip });
  } catch (e) {
    // Неожиданный сбой обработки аутентифицированного события: отвечаем 500,
    // чтобы АТОЛ повторил доставку. Запись журнала и смена статуса атомарны,
    // поэтому повтор безопасно доведёт дело до конца.
    log.error('atol.webhook: сбой обработки callback', {
      orderId: callback.orderId,
      type: callback.type,
      error: e instanceof Error ? e.message : String(e),
    });
    return new NextResponse('Internal Server Error', { status: 500 });
  }

  if (!result.accepted) {
    // Событие прошло аутентификацию, но сервис не отнёс его ни к одному заказу
    // (единственная причина — заказ не найден по payment_ref).
    //
    // 🔴 Отвечаем 200, а НЕ 403. Ретраить тут нечего: заказа у нас нет и не
    // появится, а 4xx/5xx заставили бы АТОЛ долбить эндпоинт до исчерпания
    // попыток. Это тот самый «штатный исход», про который сказано в шапке.
    // Разбираться с такими событиями нужно по журналу, а не кодом ответа.
    log.warn('atol.webhook: событие не отнесено ни к одному заказу', {
      ip,
      orderId: callback.orderId,
      type: callback.type,
      reason: result.reason ?? null,
    });
    return ok();
  }

  log.info('atol.webhook: callback обработан', {
    orderId: callback.orderId,
    type: callback.type,
    // Значения из тела идут ТОЛЬКО в журнал: статус заказа определила сверка
    // через API внутри сервиса, а не эти поля.
    status: callback.status,
    paymentStatus: callback.paymentStatus ?? null,
    inserted: result.inserted,
    processed: result.processed,
    reason: result.reason ?? null,
  });

  return ok();
}

/** Проверка доступности эндпоинта. Callback не обрабатывает. */
export async function GET(): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return new NextResponse('Not Found', { status: 404 });
  }
  return NextResponse.json({ ok: true, provider: 'atol' });
}
