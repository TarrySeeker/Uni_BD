/**
 * Cron-роут обновления курсов валют отображения (мультивалюта витрины).
 * Защищённый HTTP-эндпоинт под общий cron-секрет инстанса, дёргается внешним
 * планировщиком (системный cron / cron-контейнер / Timeweb).
 *
 *   POST|GET /api/cron/exchange/update-rates?key=<CRON_SECRET>
 *   либо заголовок X-Cron-Secret: <CRON_SECRET>
 *
 * Защита (как /api/cron/cdek и /api/cron/payments):
 *   • cron-секрет не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ не совпал/отсутствует → 401;
 *   • неизвестная задача → 404.
 *
 * Мультивалюта — core (не togglable-модуль), поэтому гейта по ADMIK_MODULES нет.
 * Сам воркер — no-op при autoRate=false / отсутствии доп.валют (см. lib/exchange/cron).
 *
 * Возвращает статистику воркера JSON. dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { runUpdateExchangeRatesProd } from '@/lib/exchange/service';
import { extractCronSecret, cronSecretMatches } from '@/lib/cron/secret';

export const dynamic = 'force-dynamic';

const TASKS = ['update-rates'] as const;
type CronTask = (typeof TASKS)[number];

async function dispatch(task: CronTask): Promise<unknown> {
  switch (task) {
    case 'update-rates':
      return runUpdateExchangeRatesProd();
  }
}

async function handle(
  req: NextRequest,
  ctx: { params: Promise<{ task: string }> },
): Promise<NextResponse> {
  const { task } = await ctx.params;

  if (!TASKS.includes(task as CronTask)) {
    return NextResponse.json({ ok: false, error: 'unknown_task', task }, { status: 404 });
  }

  // cron-секрет общий для всех cron-роутов инстанса (исторически CDEK_CRON_SECRET).
  const cfg = getCdekConfig();
  if (!cfg.cronSecret) {
    return NextResponse.json({ ok: false, error: 'cron_secret_not_configured' }, { status: 503 });
  }

  const provided = extractCronSecret(req);
  if (!provided || !cronSecretMatches(provided, cfg.cronSecret)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const stats = await dispatch(task as CronTask);
    return NextResponse.json({ ok: true, task, stats });
  } catch (err) {
    // Детали ошибки — только в серверный лог; наружу обобщённый код (анти-утечка).
    console.error(`[cron/exchange] worker_error на задаче ${task}:`, err);
    return NextResponse.json({ ok: false, error: 'worker_error', task }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ task: string }> },
): Promise<NextResponse> {
  return handle(req, ctx);
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ task: string }> },
): Promise<NextResponse> {
  return handle(req, ctx);
}
