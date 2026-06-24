/**
 * Сборка SeoCtx для DTO-мапперов из эффективных настроек магазина
 * (docs/11 §5.3.4, пакет 5.S-1).
 *
 * Чистая функция: принимает срез настроек (env ⊕ БД), функцию publicUrl
 * (storage.publicUrl — домен не хардкодим) и pathPrefix сущности. Роут вызывает
 * её с getEffectiveSettings()+getStorage().url; билдеры меты (buildSeoMeta) тогда
 * остаются чистыми и не лезут в БД/storage сами.
 */

import type { SeoCtx } from '@/lib/seo/meta';
import type { EffectiveSettings } from '@/lib/config/settings';

/** Минимальный срез эффективных настроек, нужный для SeoCtx. */
export interface SeoSettingsSlice {
  seo: EffectiveSettings['seo'];
}

/**
 * Собирает SeoCtx из эффективных настроек. `publicUrl` инъецируется (например
 * `(k) => getStorage().url(k)`), `pathPrefix` — product/category/brand/page.
 */
export function buildEntitySeoCtx(
  settings: SeoSettingsSlice,
  publicUrl: (key: string) => string,
  pathPrefix: string,
): SeoCtx {
  const seo = settings.seo;
  return {
    siteUrl: seo.site_url ?? null,
    titleTemplate: seo.title_template,
    siteName: seo.site_name ?? null,
    defaultDescription: seo.default_description ?? null,
    defaultOgImageKey: seo.default_og_image_key ?? null,
    publicUrl,
    pathPrefix,
  };
}
