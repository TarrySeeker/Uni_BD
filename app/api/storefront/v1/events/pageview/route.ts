/**
 * POST /api/storefront/v1/events/pageview — beacon посещения витрины (Prevki.md:
 * график «посещения» на дашборде). Витрина шлёт лёгкий запрос при открытии
 * страницы; здесь — UPSERT-инкремент суточного счётчика storefront_pageviews.
 *
 * Конвейер runStorefront: authorizeStorefront (ключ/Origin) → rate-limit → CORS.
 * `module: null` — core-always-on (учёт посещений не зависит от catalog/orders).
 * Тело не требуется и ИГНОРИРУЕТСЯ (никакого PII — считаем только факт открытия).
 *
 * Best-effort: ошибка записи НЕ ломает витрину — всегда отвечаем 200 { ok:true }.
 */

import {
  runStorefront,
  jsonData,
  handlePreflight,
} from '@/lib/storefront/response';
import { STOREFRONT_WRITE_METHODS } from '@/lib/storefront/cors';
import { recordPageview } from '@/lib/analytics/repository';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      try {
        await recordPageview();
      } catch (err) {
        // Учёт посещений — не критичный путь: логируем и отвечаем успехом,
        // чтобы сбой счётчика не влиял на загрузку витрины.
        logger.warn('pageview beacon: не удалось записать посещение', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return jsonData({ ok: true }, {}, cors);
    },
    { module: null, methods: STOREFRONT_WRITE_METHODS },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, STOREFRONT_WRITE_METHODS);
}
