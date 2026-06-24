/**
 * Cron-роуты СДЭК (docs/08 §9): защищённые HTTP-эндпоинты под cron-секрет,
 * дёргаются внешним планировщиком (системный cron / cron-контейнер / Timeweb).
 *
 *   POST|GET /api/cron/cdek/<task>?key=<CDEK_CRON_SECRET>
 *   либо заголовок X-Cron-Secret: <CDEK_CRON_SECRET>
 *
 * <task> ∈ { create-pending | refresh-active | notify-stuck }.
 *
 * Защита:
 *   • CDEK_CRON_SECRET не задан → 503 (роут выключен, чтобы не работать открытым);
 *   • ключ не совпал/отсутствует → 401;
 *   • неизвестная задача → 404;
 *   • модуль cdek выключен → 200 { skipped: true } (no-op, docs/08 §9).
 *
 * Возвращает статистику воркера JSON. dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import { runCreatePending, runRefreshActive, runNotifyStuck } from '@/lib/cdek/cron';

export const dynamic = 'force-dynamic';

const TASKS = ['create-pending', 'refresh-active', 'notify-stuck'] as const;
type CronTask = (typeof TASKS)[number];

/** Извлекает секрет из ?key= или заголовка X-Cron-Secret. */
function extractSecret(req: NextRequest): string | null {
  const fromQuery = req.nextUrl.searchParams.get('key');
  if (fromQuery) return fromQuery;
  const fromHeader = req.headers.get('x-cron-secret');
  return fromHeader && fromHeader.length > 0 ? fromHeader : null;
}

/** Постоянное по времени сравнение секрета (анти-timing). */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function dispatch(task: CronTask): Promise<unknown> {
  switch (task) {
    case 'create-pending':
      return runCreatePending();
    case 'refresh-active':
      return runRefreshActive();
    case 'notify-stuck':
      return runNotifyStuck();
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

  const cfg = getCdekConfig();

  // Секрет обязателен: без него роут считается выключенным (не работаем открытым).
  if (!cfg.cronSecret) {
    return NextResponse.json(
      { ok: false, error: 'cron_secret_not_configured' },
      { status: 503 },
    );
  }

  const provided = extractSecret(req);
  if (!provided || !secretMatches(provided, cfg.cronSecret)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Модуль выключен → no-op (docs/08 §9: воркеры — no-op при выключенном cdek).
  // Авторитетный гейт (env ⊕ БД-оверрайд): выключение из UI тоже останавливает воркер.
  if (!(await isModuleEffectivelyEnabled('cdek'))) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'module_disabled', task });
  }

  try {
    const stats = await dispatch(task as CronTask);
    return NextResponse.json({ ok: true, task, stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: 'worker_error', task, message }, { status: 500 });
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
