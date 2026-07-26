/**
 * Cron-роут уборки брошенных неоплаченных заказов (аудит 2026-07-26: критичное №4
 * «сгоревший баланс подарочного сертификата» + major №13 «вечный резерв склада»):
 * защищённый HTTP-эндпоинт под общий cron-секрет инстанса, дёргается внешним
 * планировщиком (cron-контейнер / системный cron / Timeweb).
 *
 *   POST|GET /api/cron/orders/expire-unpaid?key=<CRON_SECRET>
 *   либо заголовок X-Cron-Secret: <CRON_SECRET>
 *
 * Задача отменяет заказы витрины с предоплатой, не оплаченные за
 * ORDERS_UNPAID_TTL_MINUTES, и возвращает: покупателю — списанный баланс
 * подарочного сертификата, магазину — резерв склада и лимит промокода. Логика и
 * обоснование выбора точки возврата — в шапке lib/orders/expire.ts.
 *
 * Защита (как /api/cron/gift, /api/cron/payments):
 *   • неизвестная задача → 404;
 *   • cron-секрет не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ не совпал/отсутствует → 401 (сравнение постоянного времени);
 *   • модуль orders выключен → 200 { skipped:true } (no-op).
 *
 * Итог прогона: успех → 200 { ok:true, task, stats }; часть заказов не доехала
 * (stats.ok=false) → 500 { ok:false, error:'run_incomplete' }; воркер бросил → 500
 * worker_error. Не-2xx на провале обязателен: планировщик ходит `curl -fsS` и видит
 * ТОЛЬКО HTTP-код — 200 маскировал бы невозвращённые деньги покупателей.
 *
 * dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { extractCronSecret, cronSecretMatches } from '@/lib/cron/secret';
import { runExpireUnpaid, type ExpireUnpaidStats } from '@/lib/orders/expire';

export const dynamic = 'force-dynamic';

const TASKS = ['expire-unpaid'] as const;
type CronTask = (typeof TASKS)[number];

async function dispatch(task: CronTask): Promise<ExpireUnpaidStats> {
  switch (task) {
    case 'expire-unpaid':
      return runExpireUnpaid();
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

  if (!(await isModuleEffectivelyEnabled('orders'))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'module_disabled', task });
  }

  try {
    const stats = await dispatch(task as CronTask);
    if (stats.ok === false) {
      console.warn(`[cron/orders] прогон ${task} не доделан: failed=${stats.failed}`);
      return NextResponse.json({ ok: false, error: 'run_incomplete', task, stats }, { status: 500 });
    }
    return NextResponse.json({ ok: true, task, stats });
  } catch (err) {
    // Детали ошибки — только в серверный лог; наружу обобщённый код (анти-утечка).
    console.error(`[cron/orders] worker_error на задаче ${task}:`, err);
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
