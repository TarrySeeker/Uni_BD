/**
 * Заголовки страниц витрины — из АДМИНКИ (settings.seo), без хардкода имени магазина.
 *
 * На боевом carrerusse.com <title> живёт в БД (thread.seo_title / BSeoFilter, см.
 * EAUrlRule::parseRequest), поэтому владелец меняет его сам. Витрина повторяет это
 * поведение: siteName и titleTemplate приходят из Storefront API /settings.
 *
 * titleTemplate — Next-совместимый шаблон с плейсхолдером '%s' под заголовок
 * страницы (напр. '%s | Carre Russe'). Дефолт '%s' = только заголовок страницы.
 */

import type { PublicSettingsDto } from './types';

/** Заголовок сайта (главная) — ровно то, что владелец задал в админке. */
export function siteTitle(settings: PublicSettingsDto | null): string {
  return settings?.seo.siteName?.trim() ?? '';
}

/**
 * Заголовок внутренней страницы: `title` подставляется в titleTemplate админки.
 * Пустой `title` → заголовок сайта. Шаблон без '%s' игнорируется (иначе заголовок
 * страницы потерялся бы совсем).
 */
export function pageTitle(
  title: string,
  settings: PublicSettingsDto | null,
): string {
  const trimmed = title.trim();
  if (!trimmed) return siteTitle(settings);

  const template = settings?.seo.titleTemplate ?? '%s';
  if (!template.includes('%s')) return trimmed;
  return template.replace('%s', trimmed);
}
