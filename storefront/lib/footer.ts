/**
 * Модель подвала витрины — ЧИСТЫЙ слой между настройками магазина и разметкой
 * (`SiteFooter.tsx`). Здесь нет React и нет литералов конкретного магазина:
 * компонент только раскладывает результат по эталонным классам
 * (`.footer-top__subscriptions` / `.footer-soc` / `.footer-top__links` /
 * `.footer-foot`, см. docs/41 §1).
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ. Содержимое подвала — ДАННЫЕ, а не разметка:
 *  - колонки ссылок  → settings.navigation.footer (админ-форма «Навигация»);
 *  - телефон         → settings.contacts.phone, фолбэк branding.supportPhone;
 *  - тексты/копирайт → settings.navigation.footerMeta (та же форма);
 *  - соцсети         → settings.contacts.socials.
 * Ни одного адреса/телефона/названия carre в коде нет. Настройка не заполнена →
 * берётся словарный дефолт локали (dict.footer.*), а не чужой бренд.
 *
 * УСТОЙЧИВОСТЬ (класс дефекта «version skew», tests/storefront-ui/settings-version-skew):
 * настройки могут прийти БЕЗ любой секции (админка и витрина — разные образы),
 * поэтому весь доступ — глубокий optional chaining, а вход допускает `null`.
 */

import type { CategoryDto, PublicSettingsDto } from './types';
import { localizedHref, type Locale } from './i18n';
import { categoryHref } from './tree';
import type { Dictionary } from './dictionaries';

/** Ссылка подвала: подпись + готовый href (локаль уже применена). */
export interface FooterLink {
  label: string;
  href: string;
}

/** Колонка `.footer-top__links-block`. */
export interface FooterColumn {
  /** Ключ для React (не отображается) — заголовок колонки либо её индекс. */
  key: string;
  links: FooterLink[];
}

/** Всё, что подвалу нужно отрисовать. Ни одного «а вдруг null» в компоненте. */
export interface FooterModel {
  subscribe: {
    title: string;
    placeholder: string;
    submitLabel: string;
    note: string;
    successTitle: string;
  };
  /** Телефон магазина: `display` — как показать, `href` — tel:. Пусто → блока нет. */
  phone: { display: string; href: string } | null;
  socials: { type: string; url: string }[];
  columns: FooterColumn[];
  copyright: string;
  designedBy: FooterLink | null;
}

/** Непустая строка после trim, иначе null. Единая трактовка «значения нет». */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Первый осмысленный кандидат. Используется везде, где у поля есть цепочка
 * «настройка магазина → запасная настройка → словарный дефолт».
 */
function firstText(...candidates: unknown[]): string {
  for (const c of candidates) {
    const v = text(c);
    if (v !== null) return v;
  }
  return '';
}

/**
 * `tel:` из произвольной записи телефона: оставляем только цифры и ведущий «+».
 * Владелец пишет «+7 (916) 336 14 99» — показываем как есть, а в href кладём
 * «+79163361499». Ничего не выдумываем: нет цифр → ссылки нет.
 */
export function telHref(phone: string): string {
  const trimmed = phone.trim();
  const plus = trimmed.startsWith('+') ? '+' : '';
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `tel:${plus}${digits}` : '';
}

/**
 * Колонки подвала ПО УМОЛЧАНИЮ, когда владелец не задал `navigation.footer`.
 *
 * Это НЕ разметка эталона, а универсальный минимум платформы: первая колонка —
 * реальные категории каталога магазина (вложенные URL, как на проде), остальные —
 * страницы, которые есть у любого инстанса Admik. Подписи — из словаря локали.
 * Как только владелец заполнит «Навигацию», этот фолбэк не используется вовсе.
 */
function defaultColumns(
  categories: CategoryDto[],
  tree: CategoryDto[],
  dict: Dictionary,
  href: (path: string) => string,
): FooterColumn[] {
  const f = dict.footer;
  const columns: FooterColumn[] = [];

  if (categories.length > 0) {
    columns.push({
      key: 'catalog',
      links: categories.map((ct) => ({
        label: ct.name,
        href: href(categoryHref(tree, ct.slug)),
      })),
    });
  }

  columns.push(
    {
      key: 'services',
      links: [
        { label: f.certificates, href: href('/certificates') },
        { label: f.corporate, href: href('/corporate') },
        { label: f.offer, href: href('/doc-offer') },
        { label: f.returns, href: href('/doc-policy') },
      ],
    },
    {
      key: 'help',
      links: [
        { label: f.delivery, href: href('/doc-delivery') },
        { label: f.userContract, href: href('/doc-user-contract') },
      ],
    },
    {
      key: 'about',
      links: [
        { label: f.aboutUs, href: href('/about') },
        { label: f.contacts, href: href('/contacts') },
      ],
    },
  );

  return columns;
}

/**
 * Колонки из настроек магазина. Абсолютные адреса (http/mailto/tel/#) остаются
 * как есть — локаль к ним не приклеивается; внутренние пути проходят через
 * localizedHref, чтобы покупатель не выпадал из своего языка.
 */
function isExternal(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href.trim());
}

/** Применяет локаль только к внутренним путям. */
export function footerHref(raw: string, locale: Locale): string {
  const value = raw.trim();
  return isExternal(value) ? value : localizedHref(value, locale);
}

/**
 * Собирает модель подвала. Единственная точка, где решается «настройка или
 * дефолт» — компонент уже ничего не выбирает.
 */
export function buildFooterModel(args: {
  categories: CategoryDto[];
  tree: CategoryDto[];
  settings: PublicSettingsDto | null;
  locale: Locale;
  dict: Dictionary;
}): FooterModel {
  const { categories, tree, settings, locale, dict } = args;
  const f = dict.footer;
  const href = (path: string) => localizedHref(path, locale);

  const meta = settings?.navigation?.footerMeta;

  // Колонки: настройка магазина > универсальный дефолт платформы.
  const configured = (settings?.navigation?.footer ?? [])
    .map((col, index) => ({
      key: text(col?.title) ?? `col-${index}`,
      links: (col?.links ?? [])
        .map((l) => ({ label: text(l?.label) ?? '', href: text(l?.href) ?? '' }))
        .filter((l) => l.label !== '' && l.href !== '')
        .map((l) => ({ label: l.label, href: footerHref(l.href, locale) })),
    }))
    // Колонка без единой валидной ссылки в разметку не идёт (пустой
    // `.footer-top__links-block` съедал бы ширину сетки впустую).
    .filter((col) => col.links.length > 0);

  // 🔴 Фолбэк решается по РЕЗУЛЬТАТУ фильтрации, а не по длине сырого массива:
  // навигация из одних битых ссылок (все href пустые после миграции настроек)
  // иначе дала бы подвал вообще без ссылок — глухой тупик для покупателя.
  const columns: FooterColumn[] =
    configured.length > 0 ? configured : defaultColumns(categories, tree, dict, href);

  // Телефон: публичный контакт магазина, иначе телефон поддержки из брендинга.
  const phoneRaw = firstText(settings?.contacts?.phone, settings?.branding?.supportPhone);
  const tel = phoneRaw ? telHref(phoneRaw) : '';

  const designedByLabel = text(meta?.designedByLabel);
  const designedByHref = text(meta?.designedByHref);

  return {
    subscribe: {
      title: firstText(meta?.subscribeTitle, f.subscribeTitle),
      placeholder: f.subscribePlaceholder,
      submitLabel: f.subscribeSubmit,
      note: firstText(meta?.subscribeNote, f.subscribeNote),
      successTitle: f.subscribeSuccess,
    },
    phone: phoneRaw && tel ? { display: phoneRaw, href: tel } : null,
    socials: (settings?.contacts?.socials ?? []).filter(
      (s) => text(s?.type) !== null && text(s?.url) !== null,
    ),
    columns,
    // Копирайт: подпись владельца > имя магазина из брендинга > пусто.
    // Год НЕ подставляем — это часть текста владельца (см. footerMetaSchema).
    copyright: firstText(meta?.copyright, settings?.branding?.shopName),
    // Кредит студии — только если владелец его задал. Без ссылки рендерится
    // текстом (эталон даёт ссылку, но это настройка конкретного магазина).
    designedBy: designedByLabel
      ? { label: designedByLabel, href: designedByHref ?? '' }
      : null,
  };
}
