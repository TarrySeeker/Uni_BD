'use client';

/**
 * Шапка + выезжающее меню витрины carre (порт из frontend/views/misc_blocks/
 * page_head.twig). Бургер тогглит класс `page-menu-open` на <body> (как в
 * оригинальном app.js); подменю раскрываются классом `.menu-block.open`.
 * Категории и контакты — из Storefront API (реальные данные).
 *
 * i18n: получает текущую `locale` и словарь `dict`. ВСЕ внутренние ссылки строятся
 * через localizedHref(path, locale) — сохраняют текущую локаль. Переключатель языка
 * (Рус/Eng/Fra) ведёт на ТОТ ЖЕ путь с новым префиксом локали (usePathname +
 * switchLocalePath). Есть два места переключения: выпадашка в .page-head-settings
 * (рядом с валютой) и блок .mm-langs внизу меню — оба активны.
 */

import { useState } from 'react';
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
import { categoryHref } from '@/lib/tree';

interface Props {
  categories: CategoryDto[];
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
 * Рекурсивный пункт выезжающего меню (порт menu-block из page_head.twig). Узел с
 * детьми — аккордеон (.menu-block.open) с внутренним списком: «Все» + дети, где
 * дети со своими детьми разворачиваются такими же вложенными menu-block.
 * Все ссылки локализованы через href(path).
 */
function MenuNode({
  node,
  tree,
  href,
  allLabel,
}: {
  node: CategoryDto;
  tree: CategoryDto[];
  href: (path: string) => string;
  allLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;

  if (!hasChildren) {
    return (
      <div className="menu-block">
        <div className="menu-block-head">
          <a href={href(categoryHref(tree, node.slug))}>{node.name}</a>
        </div>
      </div>
    );
  }

  return (
    <div className={`menu-block${open ? ' open' : ''}`}>
      <div
        className="menu-block-head js-toggle-open"
        onClick={() => setOpen((o) => !o)}
      >
        <a
          href={href(categoryHref(tree, node.slug))}
          onClick={(e) => e.stopPropagation()}
        >
          {node.name}
        </a>
        <span className="menu-block-head--plus">+</span>
        <span className="menu-block-head--minus">—</span>
      </div>
      <div className="menu-block-links">
        <a href={href(categoryHref(tree, node.slug))}>{allLabel}</a>
        {node.children.map((child) =>
          child.children.length > 0 ? (
            <MenuNode
              key={child.slug}
              node={child}
              tree={tree}
              href={href}
              allLabel={allLabel}
            />
          ) : (
            <a key={child.slug} href={href(categoryHref(tree, child.slug))}>
              {child.name}
            </a>
          ),
        )}
      </div>
    </div>
  );
}

export default function SiteHeader({
  categories,
  settings,
  locale,
  enabledLocales,
  dict,
}: Props) {
  const { count, mounted } = useCart();
  const { count: favCount, mounted: favMounted } = useFavorites();
  const { currencies, selected, setCurrency } = useCurrency();
  const pathname = usePathname() || '/';

  // Локализованная внутренняя ссылка (сохраняет текущую локаль).
  const href = (path: string) => localizedHref(path, locale);
  // Ссылка «тот же путь на другом языке» (для переключателя).
  const langHref = (target: Locale) => switchLocalePath(pathname, target);

  const setBodyMenu = (on: boolean) => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('page-menu-open', on);
    }
  };

  const email = settings?.contacts?.email ?? settings?.branding?.supportEmail ?? '';
  const phone = settings?.contacts?.phone ?? settings?.branding?.supportPhone ?? '';
  // Знак валюты в шапке = выбранная валюта отображения (до маунта — базовая ₽).
  const sign = selected.symbol;
  // Переключатель валют показываем, только если есть доп.валюты (иначе — статичный ₽).
  const hasMultiCurrency = currencies.length > 1;

  return (
    <>
      <div className="page-head">
        <div className="burger js-menu-open" onClick={() => setBodyMenu(true)}>
          <div />
          <div />
        </div>
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
                  <div
                    key={c.code}
                    className={`page-head-settings__dd-item${
                      c.code === selected.code ? ' is-active' : ''
                    }`}
                    data-label={c.symbol}
                    role="button"
                    aria-label={fillTemplate(dict.header.currencyAria, { code: c.code })}
                    onClick={() => setCurrency(c.code)}
                  >
                    {c.code}
                  </div>
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

      <div className="page-menu">
        <div className="page-menu-top scrollbar">
          <div className="burger burger--closed js-menu-close" onClick={() => setBodyMenu(false)}>
            <div />
            <div />
          </div>
          <div className="page-menu-top-main">
            <div className="menu-block form-search">
              <img src="/images/search.svg" alt="" />
              <form action={href('/search')}>
                <input type="text" name="q" placeholder={dict.header.searchPlaceholder} />
              </form>
            </div>
            {categories.map((cat) => (
              <MenuNode
                key={cat.slug}
                node={cat}
                tree={categories}
                href={href}
                allLabel={dict.common.all}
              />
            ))}
            <div className="menu-block">
              <div className="menu-block-head">
                <a href={href('/about')}>{dict.header.aboutUs}</a>
              </div>
            </div>
            <div className="menu-block" />
          </div>
          <div className="page-menu-top-links">
            <a href={href('/corporate')}>{dict.header.corporate}</a>
            <a href={href('/certificates')}>{dict.header.certificates}</a>
          </div>
          <div className="page-menu-top-links">
            <a href={href('/favorite')}>{dict.header.favorites}</a>
            <a href={href('/cart')}>{dict.header.cart}</a>
            <a href={href('/contacts')}>{dict.header.contacts}</a>
          </div>
        </div>
        <div className="page-menu-footer">
          {email && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">{dict.header.forCustomers}</div>
              <div className="page-menu-footer-item--info">
                <a href={`mailto:${email}`}>{email}</a>
              </div>
            </div>
          )}
          {phone && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">{dict.header.phoneWhatsapp}</div>
              <div className="page-menu-footer-item--info">
                <a href={`tel:${phone}`}>{phone}</a>
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
                  >
                    {LOCALE_LABELS[l]}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
