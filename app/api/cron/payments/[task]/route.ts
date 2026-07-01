/**
 * Cron-роуты платежей Т-Банк (Фича #16): защищённые HTTP-эндпоинты под cron-секрет,
 * дёргаются внешним планировщиком (cron-контейнер / системный cron / Timeweb).
 *
 *   POST|GET /api/cron/payments/<task>?key=<CRON_SECRET>
 *   либо заголовок X-Cron-Secret: <CRON_SECRET>
 *
 * <task> ∈ { reconcile-pending } — сверка статуса оплаты по «зависшим» tbank-заказам.
 *
 * Защита (как /api/cron/cdek):
 *   • cron-секрет не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ не совпал/отсутствует → 401;
 *   • неизвестная задача → 404;
 *   • модуль payments выключен → 200 { skipped: true } (no-op).
 *
 * Возвращает статистику воркера JSON. dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { runReconcilePending } from '@/lib/payments/tbank/cron';
import { extractCronSecret, cronSecretMatches } from '@/lib/cron/secret';

export const dynamic = 'force-dynamic';

const TASKS = ['reconcile-pending'] as const;
type CronTask = (typeof TASKS)[number];

async function dispatch(task: CronTask): Promise<unknown> {
  switch (task) {
    case 'reconcile-pending':
      return runReconcilePending();
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

  // Модуль выключен → no-op (авторитетный гейт env ⊕ БД-оверрайд).
  if (!(await isModuleEffectivelyEnabled('payments'))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'module_disabled', task });
  }

  try {
    const stats = await dispatch(task as CronTask);
    return NextResponse.json({ ok: true, task, stats });
  } catch (err) {
    // Детали ошибки (могут содержать имена таблиц/SQL) — ТОЛЬКО в серверный лог;
    // наружу отдаём обобщённый код без message (анти-утечка, security-fix LOW).
    console.error(`[cron/payments] worker_error на задаче ${task}:`, err);
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
