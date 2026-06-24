/**
 * Чистый билдер robots-правил (docs/11 §5.3.4, пакет 5.S-1).
 *
 * buildRobots(ctx) → правила + строка Sitemap + robots_extra. БЕЗ чтения env/БД
 * внутри: NODE_ENV/домен/настройки передаются параметром. core-always-on роут
 * (app/robots.ts) сам читает окружение/настройки и вызывает билдер.
 *
 * Инвариант (§5.3.4):
 *   - prod → Allow '/', Disallow '/admin','/api/' (кроме '/api/storefront');
 *   - non-prod (NODE_ENV!=='production' ИЛИ noindex_site) → Disallow '/' (закрыто);
 *   - Sitemap-строка с доменом из настроек (без домена → нет строки, не хардкод);
 *   - robots_extra дописывается «как есть».
 */

/** Контекст билдера robots. */
export interface RobotsCtx {
  /** Окружение Node (определяет prod/non-prod). */
  nodeEnv: string;
  /** Базовый домен (shop_settings.seo.site_url); null → нет Sitemap-строки. */
  siteUrl: string | null;
  /** Принудительный noindex всего сайта (staging-флаг). */
  noindexSite: boolean;
  /** Произвольный «хвост» robots.txt (shop_settings.seo.robots_extra). */
  robotsExtra: string | null;
}

/** Одно правило robots (совместимо с next MetadataRoute.Robots['rules']). */
export interface RobotsRule {
  userAgent: string;
  allow?: string | string[];
  disallow?: string | string[];
}

/** Результат билдера: правила + Sitemap + extra. */
export interface RobotsResult {
  rules: RobotsRule[];
  sitemap?: string;
  /** robots_extra «как есть» (роут дописывает после стандартного блока). */
  extra?: string;
}

/**
 * Строит robots-правила по контексту (чистая функция). non-prod/noindex_site →
 * закрытый сайт (Disallow /); prod → открытый каталог при закрытых /admin,/api.
 */
export function buildRobots(ctx: RobotsCtx): RobotsResult {
  const siteUrl = ctx.siteUrl?.replace(/\/+$/, '') ?? null;
  const blocked = ctx.nodeEnv !== 'production' || ctx.noindexSite;

  const rules: RobotsRule[] = blocked
    ? [{ userAgent: '*', disallow: '/' }]
    : [
        {
          userAgent: '*',
          // /api/storefront — публичный API витрины (исключение из Disallow /api).
          allow: ['/', '/api/storefront'],
          disallow: ['/admin', '/api/'],
        },
      ];

  return {
    rules,
    ...(siteUrl ? { sitemap: `${siteUrl}/sitemap.xml` } : {}),
    ...(ctx.robotsExtra && ctx.robotsExtra.trim() ? { extra: ctx.robotsExtra.trim() } : {}),
  };
}
