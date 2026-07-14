/**
 * GET /api/storefront/v1/news — публичная лента новостей (docs/24 §3).
 *
 * Query: limit(1..50, def 12), offset(>=0), group (рубрика), locale. Отдаёт ТОЛЬКО
 * status='published' (фильтр в репозитории getPublishedNews), ручной порядок →
 * свежие выше. Гейт module:'news' ОБЯЗАТЕЛЕН. Внутренние поля скрыты в DTO;
 * переводимые поля резолвятся по ctx.locale (без body — лента лёгкая).
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { getPublishedNews } from '@/lib/news/repository';
import { toPublicNewsListDto } from '@/lib/storefront/news-dto';
import { localizeCtxFrom } from '@/lib/storefront/locale';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

function parseIntOr(v: string | null, def: number): number {
  if (v === null) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export async function GET(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async (ctx) => {
      const { cors } = ctx;
      const loc = localizeCtxFrom(ctx);
      const q = new URL(req.url).searchParams;

      const limit = Math.min(50, Math.max(1, parseIntOr(q.get('limit'), 12)));
      const offset = Math.max(0, parseIntOr(q.get('offset'), 0));
      const group = q.get('group')?.trim() || undefined;

      const { rows, total } = await getPublishedNews({ limit, offset, group });

      const storage = getStorage();
      const data = rows.map((r) => toPublicNewsListDto(r, (k) => storage.url(k), loc));

      return jsonData(
        data,
        { pagination: { total, limit, offset, count: data.length } },
        cors,
      );
    },
    { module: 'news' },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
