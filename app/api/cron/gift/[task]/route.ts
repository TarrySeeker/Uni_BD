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
import {
  runIssuePending,
  runExpireOutdated,
  type IssuePendingStats,
} from '@/lib/gift-certificates/cron';
import { GIFT_EXPIRE_TASK } from '@/lib/gift-certificates/lifecycle';

export const dynamic = 'force-dynamic';

/**
 * Задачи роута:
 *   issue-pending   — догоняющий автовыпуск по оплаченным заказам (ТЗ п.11);
 *   expire-outdated — пометка истёкших кодов статусом 'expired' (минор аудита №3:
 *                     статус не выставлялся НИКОГДА, и админка показывала
 *                     истёкший сертификат «Активен»).
 *
 * 🔴 ИМЕНА ЗДЕСЬ — ЛИТЕРАЛЫ, а не ссылки на константы. Так требует guard паритета
 * расписания (tests/build/cron-crontab-parity.guard): он читает `const TASKS` из
 * ИСХОДНИКА и не исполняет модуль, поэтому вычисляемое имя стало бы для него
 * невидимым — задача молча осталась бы без строки в crontab. Совпадение литерала
 * с доменной константой закреплено проверкой ниже.
 */
const TASKS = ['issue-pending', 'expire-outdated'] as const;
type CronTask = (typeof TASKS)[number];

/**
 * Страховка от расхождения литерала выше и доменного имени задачи: если
 * GIFT_EXPIRE_TASK переименуют, тип перестанет сходиться на этапе компиляции.
 */
const _EXPIRE_TASK_MATCHES: (typeof TASKS)[1] = GIFT_EXPIRE_TASK;

async function dispatch(task: CronTask): Promise<IssuePendingStats> {
  switch (task) {
    case 'issue-pending':
      return runIssuePending();
    case 'expire-outdated':
      return runExpireOutdated();
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
