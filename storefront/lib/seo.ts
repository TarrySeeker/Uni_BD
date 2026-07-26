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
 *
 * 🔴 УСТОЙЧИВОСТЬ К VERSION SKEW. Витрина и админка — РАЗНЫЕ образы и выкатываются
 * порознь, поэтому ответ `/settings` может прийти БЕЗ секции `seo` (у старой админки
 * поля ещё нет / новая переименовала). Раньше layout читал titleTemplate одним
 * уровнем optional chaining — `?.` стоял только на самих настройках, а отсутствие
 * секции давало TypeError внутри generateMetadata, то есть 500 на КАЖДОЙ странице
 * живого магазина. Поэтому форму настроек знает ровно ОДНО место — аксессоры ниже
 * (sectionOf), а страницы читают SEO только через них.
 *
 * Тот же класс дефекта на уровне ПОЛЯ: секция пришла, а поле пустое/чужого типа.
 * `seo.siteName` по контракту nullable, и null — ШТАТНОЕ значение провода (сервер
 * собирает его как `seo.site_name ?? branding-override ?? env.SHOP_NAME`, см.
 * lib/config/settings.ts), тогда как имя магазина всегда лежит в `branding.shopName`.
 * Поэтому: `''` / пробелы / `null` / `undefined` / НЕ-строка трактуются одинаково —
 * «значения нет» (одна функция meaningful на все аксессоры), а имя сайта имеет
 * фолбэк seo.siteName → branding.shopName.
 */

import type { Metadata } from 'next';
import type { PublicSettingsDto } from './types';

/**
 * Секция настроек, устойчиво: нет настроек / настройки не объект / нет секции /
 * секция не объект → пустой объект. Все аксессоры ходят в настройки только отсюда.
 */
function sectionOf<K extends keyof PublicSettingsDto>(
  settings: PublicSettingsDto | null | undefined,
  key: K,
): Partial<PublicSettingsDto[K]> {
  const section: unknown = settings?.[key];
  return section && typeof section === 'object'
    ? (section as Partial<PublicSettingsDto[K]>)
    : {};
}

/**
 * Осмысленное значение поля или undefined. Пустая строка, пробелы, null, undefined
 * и НЕ-строка (version skew сменил тип поля — `.trim()` на числе бросил бы
 * TypeError, то есть снова 500 в generateMetadata) — всё это «значения нет».
 */
function meaningful(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Заголовок сайта (главная) — имя магазина из админки. `seo.siteName` приоритетнее
 * (владелец задал SEO-имя явно), иначе `branding.shopName`; ничего нет → ''.
 * Своего дефолта НЕТ: выдумывать имя чужого магазина витрина не имеет права
 * (мультитенантность).
 */
export function siteTitle(settings: PublicSettingsDto | null | undefined): string {
  return (
    meaningful(sectionOf(settings, 'seo').siteName) ??
    meaningful(sectionOf(settings, 'branding').shopName) ??
    ''
  );
}

/**
 * Шаблон `title.template` для корневого layout. Возвращает шаблон владельца ТОЛЬКО
 * если в нём есть плейсхолдер '%s' (иначе Next подменил бы им заголовок страницы
 * целиком); иначе тождественный '%s' = только заголовок страницы.
 */
export function siteTitleTemplate(settings: PublicSettingsDto | null | undefined): string {
  const template = meaningful(sectionOf(settings, 'seo').titleTemplate);
  return template && template.includes('%s') ? template : '%s';
}

/** Описание по умолчанию из админки (пустое/пробельное → undefined, не пустой мета-тег). */
export function siteDescription(
  settings: PublicSettingsDto | null | undefined,
): string | undefined {
  return meaningful(sectionOf(settings, 'seo').defaultDescription);
}

/**
 * `Metadata.title` корневого layout: `default` — для страниц без своего заголовка,
 * `template` — применяется к title-СТРОКАМ дочерних страниц (там и появляется имя
 * магазина, ровно один раз). Чистая функция → тестируется без рендера Next.
 */
export function rootTitle(
  settings: PublicSettingsDto | null | undefined,
): NonNullable<Metadata['title']> {
  return { default: siteTitle(settings), template: siteTitleTemplate(settings) };
}

/**
 * Собственный заголовок страницы СТРОКОЙ (шаблон Next к ней применится) — первый
 * осмысленный кандидат: имя сущности, затем словарный фолбэк раздела.
 *
 * Пустая строка в `Metadata.title` — не «нет заголовка», а полноценный заголовок:
 * Next прогонит её через `title.template` и отдаст висящий суффикс ' — Carré Russe'
 * (либо пустой <title> при тождественном шаблоне). Поэтому пустое/пробельное имя
 * сущности обязано уступать место фолбэку — тем же правилом, что и в metaTitle.
 */
export function ownTitle(...candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    const value = meaningful(candidate);
    if (value) return value;
  }
  return '';
}

/**
 * Заголовок страницы для Next `Metadata.title`.
 *
 * @param serverTitle готовый заголовок от Storefront API (`meta.title` / `meta.ogTitle`):
 *   шаблон к нему УЖЕ применён на сервере → отдаём `{ absolute }`, Next его не тронет.
 * @param ownTitle собственный заголовок страницы (имя товара/страницы/дизайнера,
 *   строка из словаря) — сырой, ему шаблон ЕЩЁ нужен → отдаём строкой.
 * @param settings настройки магазина — фолбэк на имя сайта, когда оба источника пусты.
 *
 * Пустую СТРОКУ отдавать нельзя: она прошла бы через шаблон и дала висящий суффикс
 * вида ' | Carre Russe'. Но и `{ absolute: '' }` плохо — пустой absolute побеждает
 * `title.default` родительского layout, и <title> не рендерится ВООБЩЕ (docs/32
 * §14.4 п.4; см. resolve-title.js Next). Отдать `undefined`, чтобы «унаследовать»
 * заголовок layout-а, тоже нельзя: Next обходит ключи объекта метаданных через
 * `for…in`, поэтому ПРИСУТСТВУЮЩИЙ ключ `title: undefined` всё равно резолвится в
 * пустой absolute (mergeMetadata, case 'title'). Поэтому при двух пустых источниках
 * берём имя сайта из настроек как `absolute` (шаблон к имени сайта не применяется —
 * та же семантика, что у `title.default`; двойного суффикса не будет).
 *
 * Единственная ветка с пустым absolute — настроек НЕТ вовсе (API настроек недоступен):
 * брать имя магазина негде, выдумывать чужое витрина не имеет права
 * (мультитенантность), и в том же состоянии корневой layout резолвится в пустой
 * заголовок тоже — то есть ничего не теряется.
 */
export function metaTitle(
  serverTitle: string | null | undefined,
  ownTitle: string | null | undefined,
  settings?: PublicSettingsDto | null,
): NonNullable<Metadata['title']> {
  const ready = meaningful(serverTitle);
  if (ready) return { absolute: ready };

  const own = meaningful(ownTitle);
  if (own) return own;

  return { absolute: siteTitle(settings) };
}
