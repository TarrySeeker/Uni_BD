import { NextResponse, type NextRequest } from 'next/server';

import { getPaykeeperConfig } from '@/lib/payments/paykeeper/config';
import { PaymentService, parseCallback } from '@/lib/payments/paykeeper/service';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { logger } from '@/lib/logger';

/** Структурный логгер колбэка PayKeeper (docs/24 §2). */
const log = logger.child({ module: 'paykeeper.callback' });

/**
 * Колбэк оплаты PayKeeper (docs/24 §2).
 *
 * Server-to-server роут (PayKeeper → наш сервер), НЕ storefront: без runStorefront,
 * без CORS. Тело — application/x-www-form-urlencoded (req.formData(), НЕ req.json()).
 * Защита (docs/24 §2):
 *   1) module-gate: модуль payments выключен → 404;
 *   2) (опц.) IP-whitelist (PAYKEEPER_WEBHOOK_IPS) — доп. слой, аутентифицирует
 *      ТОЛЬКО за доверенным прокси (PAYKEEPER_WEBHOOK_TRUST_PROXY=true). ГЛАВНАЯ
 *      защита — подпись key;
 *   3) ГЛАВНОЕ — проверка подписи key = md5(id+sum+clientid+orderid+secret) в теле
 *      (verifyCallbackSignature на PAYKEEPER_SECRET); невалид → НЕ обрабатываем и
 *      отвечаем НЕ-OK (400);
 *   4) идемпотентная обработка handleCallback (UNIQUE (invoice_id, status)).
 *
 * КЛЮЧЕВОЕ (docs/24 §2): на ВЕРИФИЦИРОВАННОМ событии (включая дубликат / заказ не
 * найден — все no-op без throw) отвечаем СТРОГО `OK `+md5(id+secret) (text/plain,
 * 200), иначе PayKeeper ретраит до 50 раз и метит платёж «без оповещения».
 * Невалидная подпись → 400 (не-OK). НЕОЖИДАННАЯ ошибка обработки → 500 (пусть
 * PayKeeper ретрайнет — recordWebhookEvent атомарна).
 */

export const dynamic = 'force-dynamic';

/** Ответ НЕ-OK (text/plain) — PayKeeper не засчитает оповещение и ретраит. */
function notOk(reason: string, status: number): NextResponse {
  return new NextResponse(`Error: ${reason}`, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/** Строгий ответ `OK `+md5(id+secret) (text/plain, 200) — как требует PayKeeper. */
function ack(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Извлекает клиентский IP. X-Forwarded-For/X-Real-IP — клиент-контролируемые;
 * доверяем ТОЛЬКО за доверенным прокси (trustProxy=true). Без trustProxy → '' сразу.
 */
function extractIp(req: NextRequest, trustProxy: boolean): string {
  if (!trustProxy) return '';
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip')?.trim();
  return real ?? '';
}

/** Проверка IP по whitelist (CIDR/точные). Пустой whitelist → пропуск. */
function ipAllowed(ip: string, whitelist: readonly string[]): boolean {
  if (!whitelist || whitelist.length === 0) return true;
  return whitelist.some((cidr) => ipInCidr(ip, cidr));
}

function ipv4ToLong(ip: string): number | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    acc = acc * 256 + n;
  }
  return acc >>> 0;
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split('/');
  const ipLong = ipv4ToLong(ip);
  const netLong = ipv4ToLong(net!);
  if (ipLong === null || netLong === null) return false;
  if (bitsRaw === undefined) return ipLong === netLong;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipLong & mask) === (netLong & mask);
}

/** GET — проверка доступности эндпоинта (верификация/health). */
export async function GET(): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, service: 'paykeeper-callback' });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const cfg = getPaykeeperConfig();

  // (1) Доп. IP-whitelist (опц.; главная защита — подпись).
  const ip = extractIp(req, cfg.webhookTrustProxy);
  if (!ipAllowed(ip, cfg.webhookAllowedIps)) {
    log.warn('callback отклонён: IP вне whitelist', { ip, status: 403 });
    return notOk('forbidden ip', 403);
  }

  // (2) Парсинг тела — form-urlencoded (НЕ json).
  let params;
  try {
    const form = await req.formData();
    const fields: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      fields[k] = typeof v === 'string' ? v : '';
    }
    params = parseCallback(fields);
  } catch {
    log.warn('callback: тело не является валидным form-urlencoded');
    return notOk('bad request', 400);
  }

  // (3) Обработка: проверка подписи внутри handleCallback.
  try {
    const result = await new PaymentService().handleCallback(params, ip || null);
    if (!result.verified || !result.ack) {
      // Невалидная/отсутствующая подпись → не-OK (400), событие игнорируется.
      log.warn('callback отклонён: неверная подпись', { status: 400 });
      return notOk('bad signature', 400);
    }
    // Верифицировано (включая дубликат / заказ не найден) → строго `OK `+md5(id+secret).
    return ack(result.ack);
  } catch (err) {
    // Неожиданная ошибка обработки ВЕРИФИЦИРОВАННОГО события → 500, чтобы PayKeeper
    // РЕТРАЙНУЛ. Безопасно: recordWebhookEvent атомарна, не оставляет осиротевшего
    // лога → повтор переприменит статус.
    log.error('callback: ошибка обработки события', {
      err: err instanceof Error ? err.message : String(err),
      status: 500,
    });
    return notOk('processing error', 500);
  }
}
