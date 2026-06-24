import { NextResponse, type NextRequest } from 'next/server';

import { getTbankConfig } from '@/lib/payments/tbank/config';
import { PaymentService } from '@/lib/payments/tbank/service';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { logger } from '@/lib/logger';

/** Структурный логгер webhook Т-Банк (docs/15 §7, порт cdek.webhook). */
const log = logger.child({ module: 'tbank.webhook' });

/**
 * Webhook уведомлений Т-Банка (docs/15 §4.2).
 *
 * Server-to-server роут (Т-Банк → наш сервер), НЕ storefront: без runStorefront,
 * без CORS. Защита (docs/15 §4.2, §7):
 *   1) module-gate: модуль payments выключен → 404;
 *   2) (опц.) IP-whitelist (TBANK_WEBHOOK_IPS) — доп. слой, аутентифицирует ТОЛЬКО
 *      за доверенным прокси (TBANK_WEBHOOK_TRUST_PROXY=true). Без trustProxy
 *      клиент-контролируемые X-Forwarded-For/X-Real-IP НЕ доверяются (см. extractIp),
 *      поэтому подделка заголовков обхода не даёт; ГЛАВНАЯ защита — Token;
 *   3) ГЛАВНОЕ — проверка Token в теле (verifyNotificationToken на TBANK_PASSWORD);
 *      невалидный → 403, НЕ обрабатываем;
 *   4) идемпотентная обработка handleWebhook (UNIQUE (payment_id, status)).
 *
 * КЛЮЧЕВОЕ (docs/15 §4.2): на УСПЕШНО прошедшем проверку Token событии при штатном
 * результате handleWebhook (включая дубликат / недопустимый переход / заказ не
 * найден / неизвестный статус — все это no-op без throw) отвечаем строго `OK`
 * (HTTP 200, text/plain), чтобы Т-Банк не ретраил бесконечно. НЕОЖИДАННАЯ ошибка
 * обработки верифицированного события (throw) → 500: пусть Т-Банк РЕТРАЙНЕТ —
 * recordWebhookEvent атомарна и при сбое не оставляет «осиротевшего» лога, повтор
 * безопасно переприменит статус. Невалидный Token → 403. Битый JSON → 400.
 *
 * GET — health/верификация эндпоинта (отдаёт ok без обработки).
 */

export const dynamic = 'force-dynamic';

/** Строгий ответ `OK` (text/plain, 200) — как требует Т-Банк (docs/15 §4.2). */
function ok(): NextResponse {
  return new NextResponse('OK', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

/**
 * Извлекает клиентский IP источника запроса (порт cdek webhook).
 *
 * SECURITY (волна 4, баг B): X-Forwarded-For / X-Real-IP — клиент-контролируемые
 * заголовки. Доверяем им ТОЛЬКО за доверенным прокси (trustProxy=true, Caddy
 * пробрасывает реальный IP соединения). БЕЗ trustProxy возвращаем '' СРАЗУ, НЕ
 * читая заголовки: иначе атакующий подделкой X-Forwarded-For/X-Real-IP из
 * TBANK_WEBHOOK_IPS прошёл бы непустой whitelist. То есть IP-whitelist
 * аутентифицирует запрос только за доверенным прокси (trustProxy=true);
 * первичная защита webhook — проверка Token в теле (см. JSDoc роута).
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

/** Проверка IP по whitelist (CIDR/точные). Пустой whitelist → пропуск (главная защита — Token). */
function ipAllowed(ip: string, whitelist: readonly string[]): boolean {
  if (!whitelist || whitelist.length === 0) return true; // доп. слой, не обязателен
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
  return NextResponse.json({ ok: true, service: 'tbank-webhook' });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const cfg = getTbankConfig();

  // (1) Доп. IP-whitelist (опц.; главная защита — Token).
  const ip = extractIp(req, cfg.webhookTrustProxy);
  if (!ipAllowed(ip, cfg.webhookAllowedIps)) {
    log.warn('webhook отклонён: IP вне whitelist', { ip, status: 403 });
    return NextResponse.json({ ok: false, error: 'forbidden_ip' }, { status: 403 });
  }

  // (2) Парсинг тела — без тела нечего верифицировать (400).
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    log.warn('webhook: тело не является валидным JSON');
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  // (3) Обработка: проверка Token внутри handleWebhook.
  try {
    const result = await new PaymentService().handleWebhook(payload);
    if (!result.verified) {
      // Невалидный/отсутствующий Token → 403, событие игнорируется (docs/15 §5.2).
      log.warn('webhook отклонён: неверный Token', { status: 403 });
      return NextResponse.json({ ok: false, error: 'invalid_token' }, { status: 403 });
    }
    // Верифицировано (включая дубликат/недопустимый переход) → строго `OK`.
    return ok();
  } catch (err) {
    // Неожиданная ошибка обработки ВЕРИФИЦИРОВАННОГО события → 500, чтобы Т-Банк
    // СДЕЛАЛ РЕТРАЙ. Это безопасно после фикса неатомарности: recordWebhookEvent
    // атомарна (одна транзакция) и при сбое откатывает ВСЁ, включая вставку лога,
    // не оставляя «осиротевшей» записи processed=false → повтор переприменит статус.
    // Известные no-op (дубликат / недопустимый переход / заказ не найден /
    // неизвестный статус) handleWebhook возвращает штатно (без throw) → они дают
    // строгий `OK` (200) выше и не ретраятся.
    log.error('webhook: ошибка обработки события', {
      err: err instanceof Error ? err.message : String(err),
      status: 500,
    });
    return NextResponse.json({ ok: false, error: 'processing_error' }, { status: 500 });
  }
}
