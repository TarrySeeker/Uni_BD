/**
 * Модель ВЫЕЗЖАЮЩЕГО МЕНЮ витрины — ЧИСТЫЙ слой между каталогом/настройками
 * магазина и разметкой (`SiteHeader.tsx`). Здесь нет React и нет литералов
 * конкретного магазина: компонент только раскладывает результат по эталонным
 * классам (`.page-menu-top-main` / `.menu-block` / `.page-menu-top-links` /
 * `.page-menu-footer`, см. docs/41 §2).
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ. Содержимое меню — ДАННЫЕ, а не разметка:
 *  - разделы каталога      → дерево категорий Storefront API (то же, что уже
 *                            приходит в шапку пропсом; ВТОРОГО запроса нет);
 *  - служебные ссылки      → settings.navigation.header (админ-форма «Навигация»);
 *  - почта покупателей     → settings.contacts.email, фолбэк branding.supportEmail;
 *  - почта дизайнеров      → settings.legalEntity.emailDesigners;
 *  - телефон               → settings.contacts.phone, фолбэк branding.supportPhone.
 * Ни «Твилли», ни support@…, ни +7 (905) … в коде нет. Магазин без дизайнерского
 * направления или без служебных страниц НЕ получает пустых пунктов: блока просто
 * не будет (см. designerEmail === null и serviceLinks === []).
 *
 * УСТОЙЧИВОСТЬ (класс дефекта «version skew», tests/storefront-ui/settings-version-skew):
 * настройки могут прийти БЕЗ любой секции (админка и витрина — разные образы),
 * поэтому весь доступ — глубокий optional chaining, а вход допускает `null`.
 */

import type { CategoryDto, PublicSettingsDto } from './types';
import { localizedHref, type Locale } from './i18n';
import { categoryHref } from './tree';
import type { Dictionary } from './dictionaries';

/** Плоская ссылка меню: подпись + готовый href (локаль уже применена). */
export interface MenuLink {
  label: string;
  href: string;
}

/**
 * Раздел каталога в меню (`.menu-block`). `expandable` — есть ли подразделы:
 * только у такого рисуется «+»/«—» и раскрывающийся `.menu-block-links`.
 * Раздел без детей на эталоне — простая ссылка БЕЗ индикатора.
 */
export interface MenuSection {
  /** Ключ для React (не отображается). */
  key: string;
  label: string;
  href: string;
  expandable: boolean;
  /** Подпункты; у раскрываемого первым всегда «Все» на сам раздел (как на проде). */
  children: MenuLink[];
}

/** Контакт низа меню: как показать + готовая ссылка (mailto:/tel:). */
export interface MenuContact {
  display: string;
  href: string;
}

/** Всё, что меню нужно отрисовать. Ни одного «а вдруг null» в компоненте. */
export interface MenuModel {
  /** Разделы каталога магазина, порядок дерева API. */
  catalog: MenuSection[];
  /** Первая группа `.page-menu-top-links` — служебные страницы владельца. */
  serviceLinks: MenuLink[];
  /** Вторая группа `.page-menu-top-links` — избранное/корзина/контакты. */
  accountLinks: MenuLink[];
  customerEmail: MenuContact | null;
  designerEmail: MenuContact | null;
  phone: MenuContact | null;
  /** Подписи блоков низа — из словаря локали (в JSX литералов нет). */
  labels: {
    forCustomers: string;
    forDesigners: string;
    phone: string;
  };
}

/** Непустая строка после trim, иначе null. Единая трактовка «значения нет». */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** Первый осмысленный кандидат в цепочке «настройка → запасная настройка». */
function firstText(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    const v = text(c);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Абсолютный/схемный адрес: локаль к нему не приклеивается. Та же трактовка, что
 * в подвале (lib/footer.footerHref) — правило маршрутизации у витрины одно.
 */
function isExternal(href: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href.trim());
}

/** Применяет локаль только к внутренним путям. */
export function menuHref(raw: string, locale: Locale): string {
  const value = raw.trim();
  return isExternal(value) ? value : localizedHref(value, locale);
}

/**
 * `tel:` из произвольной записи телефона: только цифры и ведущий «+». Владелец
 * пишет «+7 (905) 043-80-74» — показываем как есть, в href кладём «+79050438074».
 * Нет цифр → контакта нет (выдумывать нечего).
 */
function telContact(raw: string | null): MenuContact | null {
  if (raw === null) return null;
  const plus = raw.startsWith('+') ? '+' : '';
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return null;
  return { display: raw, href: `tel:${plus}${digits}` };
}

/** `mailto:` из адреса. Пусто → контакта нет. */
function mailContact(raw: string | null): MenuContact | null {
  if (raw === null) return null;
  return { display: raw, href: `mailto:${raw}` };
}

/**
 * Разделы каталога → пункты меню. Раскрываемым считается раздел, у которого есть
 * подразделы; первым подпунктом идёт «Все» на сам раздел — ровно как на эталоне.
 * Адреса вложенные (`/catalog/родитель/ребёнок`) — их строит общий categoryHref
 * по ТОМУ ЖЕ дереву, что рисует каталог, поэтому ссылки меню и каталога не
 * разъезжаются.
 */
function catalogSections(
  categories: CategoryDto[],
  tree: CategoryDto[],
  locale: Locale,
  allLabel: string,
): MenuSection[] {
  return categories.map((node) => {
    const selfHref = menuHref(categoryHref(tree, node.slug), locale);
    const kids = node.children ?? [];
    return {
      key: node.slug,
      label: node.name,
      href: selfHref,
      expandable: kids.length > 0,
      children:
        kids.length > 0
          ? [
              { label: allLabel, href: selfHref },
              ...kids.map((child) => ({
                label: child.name,
                href: menuHref(categoryHref(tree, child.slug), locale),
              })),
            ]
          : [],
    };
  });
}

/**
 * Собирает модель меню. Единственная точка, где решается «настройка или её нет» —
 * компонент уже ничего не выбирает и ничего не прячет условиями по данным.
 */
export function buildMenuModel(args: {
  /** Корневые разделы каталога (тот же набор, что уже приходит в шапку). */
  categories: CategoryDto[];
  /** Полное дерево — источник вложенных путей `/catalog/родитель/ребёнок`. */
  tree: CategoryDto[];
  settings: PublicSettingsDto | null;
  locale: Locale;
  dict: Dictionary;
}): MenuModel {
  const { categories, tree, settings, locale, dict } = args;
  const h = dict.header;

  const customerEmail = mailContact(
    firstText(settings?.contacts?.email, settings?.branding?.supportEmail),
  );
  const designerRaw = firstText(settings?.legalEntity?.emailDesigners);
  // Дизайнерская почта совпала с покупательской → второго блока не рисуем:
  // одна и та же строка дважды в низу меню выглядит ошибкой, а не заботой.
  const designerEmail =
    designerRaw !== null && designerRaw !== customerEmail?.display
      ? mailContact(designerRaw)
      : null;

  // Служебные ссылки владельца («Корпоративным клиентам», «Подарочные сертификаты»
  // у одного магазина; «Оптовикам», «Franchise» — у другого). Не задал → группы нет.
  const serviceLinks: MenuLink[] = (settings?.navigation?.header ?? [])
    .map((item) => ({
      label: text(item?.label) ?? '',
      href: text(item?.href) ?? '',
    }))
    .filter((l) => l.label !== '' && l.href !== '')
    .map((l) => ({ label: l.label, href: menuHref(l.href, locale) }));

  return {
    catalog: catalogSections(categories, tree, locale, dict.common.all),
    serviceLinks,
    // Личные разделы витрины — это её собственные маршруты, а не контент магазина:
    // они есть у любого инстанса платформы, поэтому берутся из словаря, а не настроек.
    accountLinks: [
      { label: h.favorites, href: menuHref('/favorite', locale) },
      { label: h.cart, href: menuHref('/cart', locale) },
      { label: h.contacts, href: menuHref('/contacts', locale) },
    ],
    customerEmail,
    designerEmail,
    phone: telContact(firstText(settings?.contacts?.phone, settings?.branding?.supportPhone)),
    labels: {
      forCustomers: h.forCustomers,
      forDesigners: h.forDesigners,
      phone: h.phoneWhatsapp,
    },
  };
}
