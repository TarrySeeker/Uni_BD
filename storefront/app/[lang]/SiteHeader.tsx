'use client';

/**
 * Шапка + выезжающее меню витрины (эталон carrerusse.com, docs/41 §2). Бургер
 * тоглит класс `page-menu-open` на <body> (как в оригинальном app.js), подменю
 * раскрываются классом `.menu-block.open` — вся анимация в CSS (`max-height`),
 * JS лишь переключает класс.
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ. Компонент — ТОЛЬКО разметка: что показать, решает чистая
 * `buildMenuModel` (lib/menu.ts). Разделы каталога — из дерева API (того же, что
 * приходит пропсом `categories`: второго запроса нет), служебные ссылки — из
 * settings.navigation.header, почты и телефон — из settings.contacts /
 * settings.legalEntity. Магазин без дизайнерской почты или без служебных страниц
 * пустых пунктов не получает — соответствующего блока просто нет.
 *
 * i18n: получает текущую `locale` и словарь `dict`. ВСЕ внутренние ссылки строятся
 * через localizedHref/menuHref — сохраняют текущую локаль. Переключатель языка
 * (Рус/Eng/Fra) ведёт на ТОТ ЖЕ путь с новым префиксом локали (usePathname +
 * switchLocalePath). Переключателя два: выпадашка `.page-head-settings` (десктоп)
 * и `.mm-row` внизу меню (мобильный, где шапочные скрыты `display:none`).
 *
 * 🔴 ВАЛЮТА — НЕ ПО КУКЕ и НЕ ПО ЯЗЫКУ. На эталоне `.js-select-currency` ставил
 * куку `currency` и делал `location.reload()`, а «€» в `.mm-cur` вёл на `/en/` —
 * то есть валюта и язык были склеены. У нас архитектура ОСОЗНАННО другая: выбор
 * живёт в localStorage (lib/currency.tsx), SSR всегда отдаёт базовую валюту,
 * пересчёт — на клиенте. Это сохраняет кеш страниц и SEO (один URL — один язык,
 * независимо от валюты). Не возвращать куку и не связывать валюту с локалью.
 *
 * ДОСТУПНОСТЬ: раскрытие раздела — <button aria-expanded>, бургер и крестик —
 * тоже кнопки (в фокус-порядке), меню закрывается по Esc с возвратом фокуса на
 * бургер, закрытое меню скрыто от ассистивных технологий (aria-hidden).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { CategoryDto, PublicSettingsDto } from '@/lib/types';
import { useCart } from '@/lib/cart';
import { useFavorites } from '@/lib/favorites';
import { useCurrency } from '@/lib/currency';
import {
  LOCALE_LABELS,
  localizedHref,
  switchLocalePath,
  type Locale,
} from '@/lib/i18n';
import { fillTemplate, type Dictionary } from '@/lib/dictionaries';
import { buildMenuModel, type MenuSection } from '@/lib/menu';

interface Props {
  /**
   * ПУНКТЫ меню — разделы каталога (технический корень `catalog` уже развёрнут
   * в layout через menuSections). Именно они рисуются как `.menu-block` с «+».
   */
  categories: CategoryDto[];
  /**
   * ПОЛНОЕ дерево категорий — источник вложенных адресов /catalog/родитель/ребёнок
   * (categoryHref идёт по нему). Разделять с `categories` обязательно: пути должны
   * строиться по всему дереву, а показываться — только разделы.
   */
  tree: CategoryDto[];
  settings: PublicSettingsDto | null;
  locale: Locale;
  /**
   * ВКЛЮЧЁННЫЕ языки магазина (enabled-набор из настроек, волна 5). Переключатель
   * рендерится ТОЛЬКО по ним — выключенный в админке язык сюда не попадает.
   */
  enabledLocales: Locale[];
  dict: Dictionary;
}

/**
 * Раздел каталога в меню (`.menu-block` эталона). Раздел С подразделами —
 * аккордеон: заголовок-кнопка тоглит `.open`, CSS меняет `max-height` подсписка
 * и подменяет «+» на «—». Раздел БЕЗ подразделов — простая ссылка без индикатора.
 *
 * Ссылка на сам раздел остаётся доступной и у раскрываемого пункта: она лежит
 * ПЕРВЫМ подпунктом («Все»), как на проде, поэтому кнопка-заголовок может
 * спокойно только раскрывать — тупика «не могу попасть в раздел» нет.
 */
function MenuSectionBlock({
  section,
  expandAriaTemplate,
}: {
  section: MenuSection;
  expandAriaTemplate: string;
}) {
  const [open, setOpen] = useState(false);

  if (!section.expandable) {
    return (
      <div className="menu-block">
        <div className="menu-block-head">
          <a href={section.href}>{section.label}</a>
        </div>
      </div>
    );
  }

  return (
    <div className={`menu-block${open ? ' open' : ''}`}>
      <button
        type="button"
        className="menu-block-head js-toggle-open"
        aria-expanded={open}
        aria-label={fillTemplate(expandAriaTemplate, { name: section.label })}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{section.label}</span>
        <span className="menu-block-head--plus" aria-hidden="true">
          +
        </span>
        <span className="menu-block-head--minus" aria-hidden="true">
          —
        </span>
      </button>
      <div className="menu-block-links">
        {section.children.map((child) => (
          <a key={`${child.href}:${child.label}`} href={child.href}>
            {child.label}
          </a>
        ))}
      </div>
    </div>
  );
}

export default function SiteHeader({
  categories,
  tree,
  settings,
  locale,
  enabledLocales,
  dict,
}: Props) {
  const { count, mounted } = useCart();
  const { count: favCount, mounted: favMounted } = useFavorites();
  const { currencies, selected, setCurrency } = useCurrency();
  const pathname = usePathname() || '/';
  const [menuOpen, setMenuOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement | null>(null);

  // Локализованная внутренняя ссылка (сохраняет текущую локаль).
  const href = (path: string) => localizedHref(path, locale);
  // Ссылка «тот же путь на другом языке» (для переключателя).
  const langHref = (target: Locale) => switchLocalePath(pathname, target);

  // Что показывать — решено ЧИСТОЙ моделью; здесь только раскладка по классам.
  const menu = buildMenuModel({
    categories,
    tree,
    settings,
    locale,
    dict,
  });

  /**
   * Класс на <body> — механика эталона (панель выезжает `transform: translateX`).
   * Состояние держим и в React: от него зависят aria-атрибуты, а рассинхрон
   * «в DOM открыто, для скринридера закрыто» — это и есть дефект доступности.
   */
  const setBodyMenu = useCallback((on: boolean) => {
    setMenuOpen(on);
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('page-menu-open', on);
    }
  }, []);

  const closeMenu = useCallback(() => {
    setBodyMenu(false);
    // Фокус не должен «упасть в body»: возвращаем его на кнопку, которая открыла.
    burgerRef.current?.focus();
  }, [setBodyMenu]);

  // Esc закрывает меню. Слушатель живёт только пока меню открыто.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen, closeMenu]);

  // Уход со страницы не должен оставить <body> с классом открытого меню.
  useEffect(
    () => () => {
      if (typeof document !== 'undefined') {
        document.body.classList.remove('page-menu-open');
      }
    },
    [],
  );

  // Знак валюты в шапке = выбранная валюта отображения (до маунта — базовая ₽).
  const sign = selected.symbol;
  // Переключатель валют показываем, только если есть доп.валюты (иначе — статичный ₽).
  const hasMultiCurrency = currencies.length > 1;

  return (
    <>
      <div className="page-head">
        <button
          type="button"
          ref={burgerRef}
          className="burger js-menu-open"
          aria-label={dict.header.openMenu}
          aria-expanded={menuOpen}
          onClick={() => setBodyMenu(true)}
        >
          <div />
          <div />
        </button>
        <div className="page-head-logo">
          <a href={href('/')}>
            <img src="/images/logo.svg" alt={settings?.branding?.shopName ?? dict.common.home} />
          </a>
        </div>
        <div className="page-head-settings">
          {hasMultiCurrency ? (
            <div className="page-head-settings__item">
              <div className="page-head-settings__dd">
                {currencies.map((c) => (
                  <button
                    key={c.code}
                    type="button"
                    className={`page-head-settings__dd-item${
                      c.code === selected.code ? ' is-active' : ''
                    }`}
                    data-label={c.symbol}
                    aria-label={fillTemplate(dict.header.currencyAria, { code: c.code })}
                    aria-pressed={c.code === selected.code}
                    onClick={() => setCurrency(c.code)}
                  >
                    {c.code}
                  </button>
                ))}
              </div>
              <span className="page-head-label">{sign || '₽'}</span>
              <span className="page-head-chevron">⌄</span>
            </div>
          ) : (
            <div className="page-head-settings__item">
              <span className="page-head-label">{sign || '₽'}</span>
            </div>
          )}
          {/* Переключатель языка — ведёт на тот же путь с новым префиксом локали. */}
          <div className="page-head-settings__item">
            <div className="page-head-settings__dd">
              {enabledLocales.map((l) => (
                <a
                  key={l}
                  href={langHref(l)}
                  className={`page-head-settings__dd-item${
                    l === locale ? ' is-active' : ''
                  }`}
                  data-label={LOCALE_LABELS[l]}
                  aria-label={fillTemplate(dict.header.langAria, { code: LOCALE_LABELS[l] })}
                >
                  {LOCALE_LABELS[l]}
                </a>
              ))}
            </div>
            {LOCALE_LABELS[locale]}
            <span className="page-head-chevron">⌄</span>
          </div>
        </div>
        <div className="page-head-icons">
          <a href={href('/search')}><img src="/images/search.svg" alt="" /></a>
          <a href={href('/favorite')}>
            <img src="/images/heart.svg" alt="" />
            {favMounted && favCount > 0 && <span className="sf-cart-count">{favCount}</span>}
          </a>
          <a href={href('/cart')}>
            <img src="/images/bag.svg" alt="" />
            {mounted && count > 0 && <span className="sf-cart-count">{count}</span>}
          </a>
        </div>
      </div>

      <nav
        className="page-menu"
        aria-label={dict.header.menuAria}
        aria-hidden={!menuOpen}
      >
        <div className="page-menu-top scrollbar">
          <button
            type="button"
            className="burger burger--closed js-menu-close"
            aria-label={dict.header.closeMenu}
            onClick={closeMenu}
          >
            <div />
            <div />
          </button>
          <div className="page-menu-top-main">
            <div className="menu-block form-search">
              <img src="/images/search.svg" alt="" />
              <form action={href('/search')}>
                <input
                  type="text"
                  name="q"
                  placeholder={dict.header.searchPlaceholder}
                  aria-label={dict.header.searchPlaceholder}
                />
              </form>
            </div>

            {/* Разделы каталога магазина — каждый со своим раскрытием. */}
            {menu.catalog.map((section) => (
              <MenuSectionBlock
                key={section.key}
                section={section}
                expandAriaTemplate={dict.header.expandSectionAria}
              />
            ))}

            <div className="menu-block">
              <div className="menu-block-head">
                <a href={href('/about')}>{dict.header.aboutUs}</a>
              </div>
            </div>
            <div className="menu-block" />
          </div>

          {/* Служебные страницы владельца. Не заданы → группы (и её линии) нет. */}
          {menu.serviceLinks.length > 0 && (
            <div className="page-menu-top-links">
              {menu.serviceLinks.map((link) => (
                <a key={`${link.href}:${link.label}`} href={link.href}>
                  {link.label}
                </a>
              ))}
            </div>
          )}

          <div className="page-menu-top-links">
            {menu.accountLinks.map((link) => (
              <a key={link.href} href={link.href}>
                {link.label}
              </a>
            ))}
          </div>
        </div>

        <div className="page-menu-footer">
          {menu.customerEmail && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">{menu.labels.forCustomers}</div>
              <div className="page-menu-footer-item--info">
                <a href={menu.customerEmail.href}>{menu.customerEmail.display}</a>
              </div>
            </div>
          )}
          {menu.designerEmail && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">{menu.labels.forDesigners}</div>
              <div className="page-menu-footer-item--info">
                <a href={menu.designerEmail.href}>{menu.designerEmail.display}</a>
              </div>
            </div>
          )}
          {menu.phone && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">{menu.labels.phone}</div>
              <div className="page-menu-footer-item--info">
                <a href={menu.phone.href}>{menu.phone.display}</a>
              </div>
            </div>
          )}
          <div className="page-menu-footer-item">
            <div className="mm-row">
              <div className="mm-langs">
                {enabledLocales.map((l) => (
                  <a
                    key={l}
                    href={langHref(l)}
                    className={`mm-langs__item${
                      l === locale ? ' mm-langs__item--active' : ''
                    }`}
                    aria-label={fillTemplate(dict.header.langAria, { code: LOCALE_LABELS[l] })}
                  >
                    {LOCALE_LABELS[l]}
                  </a>
                ))}
              </div>
              {/*
                Валюта в низу меню. Тот же useCurrency, что и в шапке — один выбор
                на весь клиент. 🔴 Здесь СОЗНАТЕЛЬНО нет ссылок на языковые
                префиксы (на эталоне «€» уводил на /en/): валюта у нас не связана
                с языком и не ставит куку — только localStorage + пересчёт клиентом.
              */}
              {hasMultiCurrency && (
                <div className="mm-cur">
                  {currencies.map((c) => (
                    <button
                      key={c.code}
                      type="button"
                      className={`mm-cur__item${
                        c.code === selected.code ? ' mm-cur__item--active' : ''
                      }`}
                      aria-label={fillTemplate(dict.header.currencyAria, { code: c.code })}
                      aria-pressed={c.code === selected.code}
                      onClick={() => setCurrency(c.code)}
                    >
                      {c.symbol || c.code}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>
    </>
  );
}
