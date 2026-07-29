/**
 * Cron-роут досылки неотправленных писем:
 *
 *   POST|GET /api/cron/mail/retry-failed?key=<CRON_SECRET>
 *   либо заголовок X-Cron-Secret: <CRON_SECRET>
 *
 * ЗАЧЕМ ЗАДАЧА. Внутренние ретраи отправки живут в пределах одного запроса
 * (секунды). Релей, лежавший десять минут, оставил бы письмо с кодом
 * подарочного сертификата — деньгами на предъявителя — в статусе failed
 * навсегда. Эта задача периодически добирает такие письма.
 *
 * Защита (как /api/cron/gift, /api/cron/cdek, /api/cron/payments):
 *   • неизвестная задача → 404;
 *   • cron-секрет не задан → 503 (роут выключен, не работаем открытым);
 *   • ключ не совпал/отсутствует → 401 (сравнение постоянного времени).
 *
 * ПОЧЕМУ НЕТ ГАРДА ПО МОДУЛЮ (в отличие от /api/cron/gift, который проверяет
 * orders): почта сквозная — письма о заказах, о доставке и о сертификатах
 * относятся к РАЗНЫМ модулям, и выключение любого из них не должно оставлять
 * уже поставленные в очередь письма недоставленными. Если слать нечего, выборка
 * кандидатов просто пуста, а магазин без SMTP отдаёт skipped и остаётся ok.
 *
 * Итог прогона: успех → 200 { ok:true, task, stats }; часть писем не доехала
 * (stats.ok=false) → 500 { ok:false, error:'run_incomplete' }; воркер бросил →
 * 500 worker_error. Не-2xx на провале обязателен: планировщик ходит `curl -fsS`
 * и видит ТОЛЬКО HTTP-код — 200 маскировал бы неотправленные письма.
 *
 * dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { extractCronSecret, cronSecretMatches } from '@/lib/cron/secret';
import { runRetryFailed, type MailRetryStats } from '@/lib/mail/cron';

export const dynamic = 'force-dynamic';

/**
 * Задачи роута:
 *   retry-failed — досылка писем со статусом failed.
 *
 * 🔴 ИМЯ ЗДЕСЬ — ЛИТЕРАЛ, а не ссылка на константу. Так требует guard паритета
 * расписания (tests/build/cron-crontab-parity.guard): он читает `const TASKS` из
 * ИСХОДНИКА и не исполняет модуль, поэтому вычисляемое имя стало бы для него
 * невидимым — задача молча осталась бы без строки в crontab.
 */
const TASKS = ['retry-failed'] as const;
type CronTask = (typeof TASKS)[number];

async function dispatch(task: CronTask): Promise<MailRetryStats> {
  switch (task) {
    case 'retry-failed':
      return runRetryFailed();
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
    if (stats.ok === false) {
      console.warn(`[cron/mail] прогон ${task} не доделан: failed=${stats.failed}`);
      return NextResponse.json(
        { ok: false, error: 'run_incomplete', task, stats },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, task, stats });
  } catch (err) {
    // Детали ошибки — только в серверный лог; наружу обобщённый код (анти-утечка).
    console.error(`[cron/mail] worker_error на задаче ${task}:`, err);
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
