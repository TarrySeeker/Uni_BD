import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig, isCdekMock } from '@/lib/cdek/config';
import { verifyWebhookIp, WebhookService } from '@/lib/cdek/services/webhook';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { logger } from '@/lib/logger';
import { safeEqual } from '@/lib/storefront/order-dto';

/** Структурный логгер webhook СДЭК (наблюдаемость, Этап 6 §6.3). */
const log = logger.child({ module: 'cdek.webhook' });

/**
 * Webhook статусов СДЭК (docs/08 §8).
 *
 * Это server-to-server роут (СДЭК → наш сервер), НЕ storefront: без runStorefront,
 * без CORS. Защита своя (после фикса безопасности):
 *   1) module-gate: модуль cdek выключен → 404;
 *   2) АУТЕНТИФИКАЦИЯ (authenticate):
 *      • СЕКРЕТ ?key= (CDEK_WEBHOOK_SECRET) — ПЕРВИЧНАЯ аутентификация
 *        (constant-time сверка). Верный ключ пропускает запрос независимо от IP.
 *      • IP-WHITELIST (CDEK_WEBHOOK_IPS) — ДОП. слой ТОЛЬКО за доверенным прокси
 *        (CDEK_WEBHOOK_TRUST_PROXY=true). SECURITY: без trustProxy
 *        клиент-контролируемые X-Forwarded-For/X-Real-IP НЕ доверяются как
 *        источник IP (docs/08 §8.2: «IP из соединения, не из X-Forwarded-For»),
 *        поэтому подделка заголовков обхода не даёт.
 *      • Вне mock-режима (есть боевые ключи) запрос обязан пройти ИЛИ секрет,
 *        ИЛИ IP-whitelist; если НЕ настроены НИ секрет, НИ whitelist — 401
 *        (роут не работает открытым, чтобы исключить запись произвольного
 *        delivery_status/raw_payload в боевые orders).
 *      • Пустой whitelist даёт bypass ТОЛЬКО в mock-режиме (нет боевых ключей) —
 *        edu/CI-контур, а НЕ при CDEK_TEST_MODE с боевыми ключами.
 *   3) парсинг тела → handleWebhookEvent (идемпотентно по UNIQUE в cdek_status_log).
 *
 * КЛЮЧЕВОЕ (docs/08 §8.2): на УСПЕШНО прошедшем защиту запросе ВСЕГДА возвращаем
 * 200 — даже на битый JSON, дубликат или ошибку хендлера, чтобы СДЭК не ретраил
 * бесконечно; проблемы логируются. Отказ защиты → 403/401.
 *
 * GET — health/верификация подписки СДЭК (отдаёт ok без обработки).
 */

export const dynamic = 'force-dynamic';

/**
 * Извлекает IP источника запроса (docs/08 §8.2). SECURITY: X-Forwarded-For /
 * X-Real-IP — клиент-контролируемые заголовки; доверяем им ТОЛЬКО за доверенным
 * прокси (trustProxy=true, Caddy пробрасывает реальный IP соединения). БЕЗ
 * trustProxy возвращаем '' — IP-whitelist в таком режиме не аутентифицирует
 * (защита должна идти секретом ?key=), иначе атакующий подделкой заголовка прошёл
 * бы whitelist. Возвращаемый ip также сохраняется в cdek_status_log.ip (аудит).
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

/** Результат аутентификации запроса вебхука. */
type AuthResult =
  | { ok: true; ip: string }
  | { ok: false; status: 401 | 403; error: string };

/**
 * Аутентифицирует входящий webhook (SECURITY-ядро, см. JSDoc роута).
 * Чистая по отношению к БД/сети: читает только cfg/headers/query.
 *
 * Порядок (defense-in-depth):
 *   (a) Если задан CDEK_WEBHOOK_SECRET — он ОБЯЗАТЕЛЕН и проверяется ПЕРВЫМ
 *       (constant-time). Неверный/отсутствующий ключ → 401 (жёсткий отказ; IP-слой
 *       НЕ перекрывает неверный секрет). Это первичная аутентификация.
 *   (b) IP-whitelist — доп. слой за доверенным прокси. Непустой список: IP должен
 *       входить (иначе 403). Пустой список: bypass ТОЛЬКО в mock-режиме (нет
 *       боевых ключей), иначе 401 — роут не работает открытым.
 */
function authenticate(req: NextRequest, cfg: ReturnType<typeof getCdekConfig>): AuthResult {
  const mock = isCdekMock();
  const ip = extractIp(req, cfg.webhookTrustProxy);

  // (a) СЕКРЕТ ?key= — обязателен, если задан; первичная аутентификация.
  if (cfg.webhookSecret) {
    const key = req.nextUrl.searchParams.get('key') ?? '';
    if (!safeEqual(key, cfg.webhookSecret)) {
      return { ok: false, status: 401, error: 'unauthorized' };
    }
  }

  // (b) IP-whitelist — доп. слой (за trustProxy). Пустой whitelist → bypass лишь
  // в mock-режиме (isMock), НЕ при CDEK_TEST_MODE с боевыми ключами.
  const ipOk = verifyWebhookIp(ip, cfg.webhookAllowedIps, {
    trustProxy: cfg.webhookTrustProxy,
    isMock: mock,
  });
  if (ipOk) return { ok: true, ip };

  // (c) IP-слой не прошёл. Если секрет был задан и верен — пускаем только при
  // непустом whitelist-провале? Нет: верный секрет — достаточная первичная
  // аутентификация; IP-whitelist для secret-аутентифицированного запроса
  // применяется лишь если whitelist настроен. Различаем 403/401:
  if (cfg.webhookSecret) {
    // Секрет верен (иначе вышли бы на шаге (a)). Whitelist либо пуст (нет доп.
    // ограничения IP) → пускаем; либо непуст и IP не прошёл → 403.
    if (cfg.webhookAllowedIps.length === 0) return { ok: true, ip };
    return { ok: false, status: 403, error: 'forbidden_ip' };
  }
  // Секрета нет: непустой whitelist + IP не прошёл → 403; пустой whitelist в
  // боевом режиме → 401 (роут не работает открытым).
  if (cfg.webhookAllowedIps.length > 0) {
    return { ok: false, status: 403, error: 'forbidden_ip' };
  }
  return { ok: false, status: 401, error: 'unauthorized' };
}

/** GET — проверка доступности эндпоинта (верификация подписки/health). */
export async function GET(): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('cdek'))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ ok: true, service: 'cdek-webhook' });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!(await isModuleEffectivelyEnabled('cdek'))) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }

  const cfg = getCdekConfig();

  // (1) Аутентификация: секрет ?key= (первичная) ИЛИ IP-whitelist за trustProxy.
  const auth = authenticate(req, cfg);
  if (!auth.ok) {
    log.warn('webhook отклонён', { status: auth.status, error: auth.error });
    console.warn(`[cdek] webhook отклонён: ${auth.error} (${auth.status}).`);
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }
  const ip = auth.ip;

  // (2) Парсинг тела — битый JSON → 200 с warn (СДЭК не должен ретраить вечно).
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    console.warn('[cdek] webhook: тело не является валидным JSON.');
    return NextResponse.json({ ok: false, warn: 'invalid_json' }, { status: 200 });
  }

  // (3) Обработка — любая ошибка хендлера → 200 с warn (логируется). IP источника
  // пробрасывается в handleWebhookEvent → cdek_status_log.ip (аудит, finding #3).
  try {
    const result = await new WebhookService().handleWebhookEvent(payload, ip || undefined);
    return NextResponse.json({
      ok: true,
      processed: result.processed,
      duplicate: result.duplicate,
    });
  } catch (err) {
    log.error('webhook: ошибка обработки события', {
      err: err instanceof Error ? err.message : String(err),
    });
    console.error('[cdek] webhook: ошибка обработки события:', err);
    return NextResponse.json({ ok: false, warn: 'handler_error' }, { status: 200 });
  }
}
