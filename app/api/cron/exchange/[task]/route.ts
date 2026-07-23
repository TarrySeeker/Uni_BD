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
 *   • неизвестная задача → 404;
 *   • базовая валюта магазина не RUB → 200 { skipped:true } (курсы ЦБ неприменимы).
 *
 * Итог прогона: успех → 200 { ok:true, task, stats }; воркер вернул ok:false
 * (ЦБ не ответил) → 502 { ok:false, reason }; воркер бросил → 500 worker_error.
 * Не-2xx на провале обязателен: планировщик ходит `curl -fsS` и видит только код.
 *
 * Мультивалюта — core (не togglable-модуль), поэтому гейта по ADMIK_MODULES нет.
 * Сам воркер — no-op при autoRate=false / отсутствии доп.валют (см. lib/exchange/cron).
 *
 * Возвращает статистику воркера JSON. dynamic='force-dynamic' — без кеша.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCdekConfig } from '@/lib/cdek/config';
import { getEffectiveSettings } from '@/lib/config/settings';
import { runUpdateExchangeRatesProd } from '@/lib/exchange/service';
import { isCbrBaseSupported, type UpdateRatesStats } from '@/lib/exchange/cron';
import { extractCronSecret, cronSecretMatches } from '@/lib/cron/secret';

export const dynamic = 'force-dynamic';

const TASKS = ['update-rates'] as const;
type CronTask = (typeof TASKS)[number];

async function dispatch(task: CronTask): Promise<UpdateRatesStats> {
  switch (task) {
    case 'update-rates':
      return runUpdateExchangeRatesProd();
  }
}

/**
 * Базовая валюта магазина. Graceful (как getEffectiveModuleSet): если настройки
 * не читаются, база неизвестна — гейт не срабатывает и прогон идёт как раньше.
 */
async function readBaseCurrencyCode(): Promise<string | undefined> {
  try {
    return (await getEffectiveSettings()).currency.code ?? undefined;
  } catch {
    return undefined;
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

  // Источник ЦБ РФ даёт «рублей за единицу валюты» → применим ТОЛЬКО к магазину с
  // базовой валютой RUB. Иначе no-op 200 { skipped } — как гейт module_disabled у
  // /api/cron/cdek и /api/cron/payments: это не сбой, а неприменимость источника.
  const base = await readBaseCurrencyCode();
  if (!isCbrBaseSupported(base)) {
    return NextResponse.json({ ok: true, skipped: true, reason: 'unsupported_base', base, task });
  }

  try {
    const stats = await dispatch(task as CronTask);
    // Провал прогона обязан быть НЕ-2xx: cron-контейнер зовёт роут `curl -fsS`,
    // а -f смотрит только на HTTP-код — 200 маскировал бы замороженный курс.
    // 502: не ответил ВНЕШНИЙ источник (ЦБ РФ), сама админка исправна.
    if (stats.ok === false) {
      console.warn(`[cron/exchange] прогон ${task} не удался: ${stats.reason ?? 'unknown'}`);
      return NextResponse.json(
        { ok: false, error: 'source_unavailable', reason: stats.reason, task, stats },
        { status: 502 },
      );
    }
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
