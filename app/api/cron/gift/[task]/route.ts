/**
 * Cron-роут догоняющего автовыпуска подарочных сертификатов (ТЗ п.11):
 * защищённый HTTP-эндпоинт под общий cron-секрет инстанса, дёргается внешним
 * планировщиком (cron-контейнер / системный cron / Timeweb).
 *
 *   POST|GET /api/cron/gift/issue-pending?key=<CRON_SECRET>
 *   либо заголовок X-Cron-Secret: <CRON_SECRET>
 *
 * Защита (как /api/cron/cdek, /api/cron/payments, /api/cron/exchange):
 *   • неизвестная задача → 404;
 *   • cron-секрет не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ не совпал/отсутствует → 401 (сравнение постоянного времени);
 *   • модуль orders выключен → 200 { skipped:true } (сертификаты живут в заказах).
 *
 * Итог прогона: успех → 200 { ok:true, task, stats }; часть заказов не доехала
 * (stats.ok=false) → 500 { ok:false, error:'run_incomplete' }; воркер бросил →
 * 500 worker_error. Не-2xx на провале обязателен: планировщик ходит `curl -fsS`
 * и видит ТОЛЬКО HTTP-код — 200 маскировал бы невыпущенные сертификаты.
 *
 * dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { extractCronSecret, cronSecretMatches } from '@/lib/cron/secret';
import { runIssuePending, type IssuePendingStats } from '@/lib/gift-certificates/cron';

export const dynamic = 'force-dynamic';

const TASKS = ['issue-pending'] as const;
type CronTask = (typeof TASKS)[number];

async function dispatch(task: CronTask): Promise<IssuePendingStats> {
  switch (task) {
    case 'issue-pending':
      return runIssuePending();
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

  // Сертификаты — часть модуля заказов: выключен он → воркер no-op.
  if (!(await isModuleEffectivelyEnabled('orders'))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'module_disabled', task });
  }

  try {
    const stats = await dispatch(task as CronTask);
    if (stats.ok === false) {
      console.warn(`[cron/gift] прогон ${task} не доделан: failed=${stats.failed}`);
      return NextResponse.json(
        { ok: false, error: 'run_incomplete', task, stats },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, task, stats });
  } catch (err) {
    // Детали ошибки — только в серверный лог; наружу обобщённый код (анти-утечка).
    console.error(`[cron/gift] worker_error на задаче ${task}:`, err);
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
