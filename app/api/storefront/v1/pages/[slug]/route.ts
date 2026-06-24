/**
 * GET /api/storefront/v1/pages/[slug] — публичная CMS-страница (docs/11 §5.1.4,
 * ADR-012). Структура копирует products/[slug]/route.ts.
 *
 * Гейт module:'cms' ОБЯЗАТЕЛЕН (runStorefront по умолчанию проверяет 'catalog').
 * Отдаёт ТОЛЬКО status='published' страницу по slug (фильтр в репозитории);
 * draft/archived ⇒ репозиторий вернёт null ⇒ 404 not_found. Внутренние поля
 * (id/status/audit/timestamps/revisions) скрыты в toPublicPageDto.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { getPublishedCmsPageBySlug } from '@/lib/cms/repository';
import { toPublicPageDto } from '@/lib/storefront/cms-dto';
import { buildEntitySeoCtx } from '@/lib/storefront/seo-ctx';
import { getEffectiveSettings } from '@/lib/config/settings';
import { getStorage } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const { slug } = await ctx.params;

      const page = await getPublishedCmsPageBySlug(slug);
      if (!page) {
        return jsonError('not_found', 'Страница не найдена.', cors);
      }

      // SEO-контекст: домен/шаблон из настроек, og:image-URL — через storage.
      const settings = await getEffectiveSettings();
      const storage = getStorage();
      const publicUrl = (k: string) => storage.url(k);
      const seoCtx = buildEntitySeoCtx(settings, publicUrl, 'page');

      // publicUrl передаётся явно: секции hero/banner/gallery отдают imageUrl
      // (публичный URL), а НЕ сырой ключ хранилища (инвариант, зеркаль каталог-медиа).
      return jsonData(toPublicPageDto(page, seoCtx, publicUrl), {}, cors);
    },
    { module: 'cms' },
  );
}

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req);
}
