/**
 * Заголовки страниц витрины — из АДМИНКИ (settings.seo), без хардкода имени магазина.
 *
 * На боевом carrerusse.com <title> живёт в БД (thread.seo_title / BSeoFilter, см.
 * EAUrlRule::parseRequest), поэтому владелец меняет его сам. Витрина повторяет это
 * поведение: siteName и titleTemplate приходят из Storefront API /settings.
 *
 * titleTemplate — Next-совместимый шаблон с плейсхолдером '%s' под заголовок
 * страницы (напр. '%s | Carre Russe'). Дефолт '%s' = только заголовок страницы.
 *
 * ГДЕ ПРИМЕНЯЕТСЯ ШАБЛОН. Ровно в двух местах, и они НЕ должны складываться:
 *   1) на сервере Admik — buildSeoMeta() прогоняет seoTitle/name сущности через
 *      applyTitleTemplate и отдаёт витрине УЖЕ ГОТОВЫЙ `meta.title`;
 *   2) в рантайме Next — `title.template` из app/[lang]/layout.tsx применяется к
 *      любому title-СТРОКЕ дочерней страницы.
 * Поэтому готовый серверный заголовок обязан ехать в Next как `{ absolute }` —
 * такой title Next шаблоном не трогает (см. resolveTitle). Иначе при шаблоне вида
 * '%s | Carre Russe' получится «Твилли микро | Carre Russe | Carre Russe».
 *
 * Своей подстановки '%s' здесь НЕТ намеренно: третья реализация правила (была
 * pageTitle() с replace первого вхождения против replaceAll у Next) неизбежно
 * разъезжается с остальными. Витрина только ВЫБИРАЕТ режим, подставляет — Next.
 */

import type { Metadata } from 'next';
import type { PublicSettingsDto } from './types';

/** Заголовок сайта (главная) — ровно то, что владелец задал в админке. */
export function siteTitle(settings: PublicSettingsDto | null): string {
  return settings?.seo.siteName?.trim() ?? '';
}

/**
 * Заголовок страницы для Next `Metadata.title`.
 *
 * @param serverTitle готовый заголовок от Storefront API (`meta.title` / `meta.ogTitle`):
 *   шаблон к нему УЖЕ применён на сервере → отдаём `{ absolute }`, Next его не тронет.
 * @param ownTitle собственный заголовок страницы (имя товара/страницы/дизайнера,
 *   строка из словаря) — сырой, ему шаблон ЕЩЁ нужен → отдаём строкой.
 *
 * Оба пустые → `{ absolute: '' }`: пустая строка прошла бы через шаблон и дала бы
 * висящий суффикс вида ' | Carre Russe'.
 */
export function metaTitle(
  serverTitle: string | null | undefined,
  ownTitle: string | null | undefined,
): NonNullable<Metadata['title']> {
  const ready = serverTitle?.trim();
  if (ready) return { absolute: ready };

  const own = ownTitle?.trim();
  return own ? own : { absolute: '' };
}
