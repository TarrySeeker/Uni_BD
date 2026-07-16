import { NextResponse, type NextRequest } from 'next/server';

import { getAlfabankConfig } from '@/lib/payments/alfabank/config';
import { PaymentService, parseCallback } from '@/lib/payments/alfabank/service';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { logger } from '@/lib/logger';

/** Структурный логгер колбэка Альфа-Банка (порт paykeeper.callback). */
const log = logger.child({ module: 'alfabank.callback' });

/**
 * Колбэк оплаты Альфа-Банка (callbackUrl, платформа RBS).
 *
 * Server-to-server роут (Альфа-Банк → наш сервер), НЕ storefront: без runStorefront,
 * без CORS. Альфа-Банк дёргает callbackUrl с QUERY-параметрами (GET и POST-form
 * поддержаны): mdOrder, orderNumber, operation (deposited/refunded/reversed), status
 * ('1' успех / '0' неуспех); опц. checksum (HMAC symmetric key).
 * Защита:
 *   1) module-gate: модуль payments выключен → 404;
 *   2) (опц.) IP-whitelist (ALFABANK_WEBHOOK_IPS) — доп. слой, аутентифицирует ТОЛЬКО
 *      за доверенным прокси (ALFABANK_WEBHOOK_TRUST_PROXY=true);
 *   3) checksum: если задан ALFABANK_CALLBACK_SECRET — проверяется в handleCallback;
 *      невалид → 400. Если секрет НЕ задан (mock/не настроен) — проверка пропускается;
 *   4) идемпотентная обработка handleCallback (UNIQUE (order_ref, status)).
 *
 * КЛЮЧЕВОЕ: Альфа-Банку достаточно HTTP 200 на успешно принятом событии (включая
 * дубликат / заказ не найден — все no-op). Невалидный checksum → 400. НЕОЖИДАННАЯ
 * ошибка обработки → 500 (пусть Альфа ретрайнет — recordWebhookEvent атомарна).
 */

export const dynamic = 'force-dynamic';

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

/** Собирает поля колбэка из query и (если есть) form-тела. */
async function readFields(req: NextRequest): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  const url = new URL(req.url);
  for (const [k, v] of url.searchParams.entries()) fields[k] = v;
  // Альфа-Банк обычно шлёт GET с query, но на POST добираем form-поля (не перетирая query).
  if (req.method === 'POST') {
    try {
      const form = await req.formData();
      for (const [k, v] of form.entries()) {
        if (fields[k] === undefined) fields[k] = typeof v === 'string' ? v : '';
      }
    } catch {
      /* нет form-тела — работаем по query */
    }
  }
  return fields;
}

/** Обработка колбэка (общая для GET и POST). */
async function handle(req: NextRequest): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const cfg = getAlfabankConfig();

  // (1) Доп. IP-whitelist (опц.; главная защита — checksum, если задан).
  const ip = extractIp(req, cfg.webhookTrustProxy);
  if (!ipAllowed(ip, cfg.webhookAllowedIps)) {
    log.warn('callback отклонён: IP вне whitelist', { ip, status: 403 });
    return NextResponse.json({ ok: false, error: 'forbidden_ip' }, { status: 403 });
  }

  // (2) Парсинг полей (query + опц. form).
  const params = parseCallback(await readFields(req));

  // (3) Обработка: проверка checksum (если секрет задан) внутри handleCallback.
  try {
    const result = await new PaymentService().handleCallback(params, ip || null);
    if (!result.verified) {
      // Задан секрет и checksum не сошёлся → 400, событие игнорируется.
      log.warn('callback отклонён: неверный checksum', { status: 400 });
      return NextResponse.json({ ok: false, error: 'invalid_checksum' }, { status: 400 });
    }
    // Верифицировано (включая дубликат / заказ не найден) → 200.
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Неожиданная ошибка обработки верифицированного события → 500 (Альфа ретрайнет).
    log.error('callback: ошибка обработки события', {
      err: err instanceof Error ? err.message : String(err),
      status: 500,
    });
    return NextResponse.json({ ok: false, error: 'processing_error' }, { status: 500 });
  }
}

/** GET — Альфа-Банк дёргает callbackUrl обычно GET-ом (query params). */
export async function GET(req: NextRequest): Promise<NextResponse> {
  // Пустой запрос без параметров трактуем как health-проверку эндпоинта.
  const url = new URL(req.url);
  if ([...url.searchParams.keys()].length === 0) {
    if (!(await isModuleEffectivelyEnabled('payments'))) {
      return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, service: 'alfabank-callback' });
  }
  return handle(req);
}

/** POST — на случай, если конфигурация ЛК шлёт колбэк POST-ом. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return handle(req);
}
