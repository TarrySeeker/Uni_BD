/**
 * GET /robots.txt (docs/11 §5.3.4, пакет 5.S-1).
 *
 * core-always-on plain-text Route Handler. Правила собирает чистый билдер
 * buildRobots по NODE_ENV/настройкам: prod → Allow /, Disallow /admin,/api (кроме
 * /api/storefront); non-prod (NODE_ENV!=='production' ИЛИ seo.noindex_site) →
 * Disallow / (защита dev/staging). Домен Sitemap — из shop_settings.seo.site_url
 * (env только bootstrap-fallback). robots_extra дописывается «как есть» после
 * стандартного блока (произвольные хвостовые строки невозможно нести в
 * MetadataRoute.Robots — поэтому роут сериализует text/plain вручную).
 *
 * Fallback при недоступности БД — закрытый сайт (безопасный дефолт).
 */

import { getEffectiveSettings } from '@/lib/config/settings';
import { buildRobots, type RobotsResult, type RobotsRule } from '@/lib/seo/robots';

/** Перегенерация раз в час (ISR). */
export const revalidate = 3600;

/** Нормализует allow/disallow поле в массив строк (поле опционально). */
function toLines(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Сериализует результат билдера в текст robots.txt: блоки правил
 * (`User-agent` + `Allow`/`Disallow`), строка `Sitemap:` и «хвост» robots_extra.
 */
function serializeRobots(built: RobotsResult): string {
  const blocks: string[] = built.rules.map((rule: RobotsRule) => {
    const lines = [`User-agent: ${rule.userAgent}`];
    for (const path of toLines(rule.allow)) lines.push(`Allow: ${path}`);
    for (const path of toLines(rule.disallow)) lines.push(`Disallow: ${path}`);
    return lines.join('\n');
  });

  let body = blocks.join('\n\n');
  if (built.sitemap) body += `\n\nSitemap: ${built.sitemap}`;
  if (built.extra) body += `\n\n${built.extra}`;
  return `${body}\n`;
}

/** Plain-text-ответ robots.txt с корректным Content-Type. */
function robotsResponse(body: string): Response {
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export async function GET(): Promise<Response> {
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  let siteUrl: string | null = null;
  let noindexSite = false;
  let robotsExtra: string | null = null;
  try {
    const settings = await getEffectiveSettings();
    siteUrl = settings.seo.site_url ?? null;
    noindexSite = settings.seo.noindex_site;
    robotsExtra = settings.seo.robots_extra ?? null;
  } catch (error) {
    // Настройки недоступны → закрываем сайт (безопасный дефолт).
    console.error('[robots] настройки недоступны, закрываем сайт:', error);
    return robotsResponse('User-agent: *\nDisallow: /\n');
  }

  const built = buildRobots({ nodeEnv, siteUrl, noindexSite, robotsExtra });
  return robotsResponse(serializeRobots(built));
}
