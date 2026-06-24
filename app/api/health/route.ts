import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { runDeepHealth } from '@/lib/health';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

const log = logger.child({ module: 'health' });

/**
 * /api/health — здоровье приложения (Этап 6, пакет 6.3; §6.3.2, ADR-015).
 *
 * Два режима в ОДНОМ роуте (выбор обоснован в отчёте/спеке):
 *   • БАЗОВЫЙ (liveness), без параметров — лёгкий и быстрый, НЕ трогает
 *     зависимости. Всегда {status:'ok'} + HTTP 200. Его дёргает healthcheck
 *     docker-compose и smoke из W1 — контракт «status:ok» сохранён.
 *   • DEEP (readiness), `?deep=1` — проверяет БД (SELECT 1), Redis (PING),
 *     S3 (HEAD bucket). Отдаёт {status, checks:{db,redis,s3}} и HTTP 503, если
 *     критичная зависимость (БД) недоступна. Для внешнего монитора и health-gate
 *     обновления (W4). Реализован как query-флаг (а не отдельный /ready), чтобы
 *     не плодить роуты и сохранить единый публичный путь /api/health.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const deep = req.nextUrl.searchParams.get('deep');
  const isDeep = deep === '1' || deep === 'true';

  if (!isDeep) {
    // Liveness: лёгкий ответ, не нагружает зависимости.
    return NextResponse.json({
      status: 'ok',
      service: 'admik',
      time: new Date().toISOString(),
    });
  }

  // Readiness: глубокая проверка зависимостей.
  const result = await runDeepHealth();
  if (result.httpStatus === 503) {
    // Недоступность критичной зависимости — значимое событие наблюдаемости.
    log.error('deep-health: критичная зависимость недоступна', {
      status: result.status,
      checks: result.checks,
    });
  }

  return NextResponse.json(
    {
      status: result.status,
      service: 'admik',
      time: new Date().toISOString(),
      checks: result.checks,
    },
    { status: result.httpStatus },
  );
}
