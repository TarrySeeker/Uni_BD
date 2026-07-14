'use client';

/**
 * Шапка + выезжающее меню витрины carre (порт из frontend/views/misc_blocks/
 * page_head.twig). Бургер тогглит класс `page-menu-open` на <body> (как в
 * оригинальном app.js); подменю раскрываются классом `.menu-block.open`.
 * Категории и контакты — из Storefront API (реальные данные).
 */

import { useState } from 'react';
import type { CategoryDto, PublicSettingsDto } from '@/lib/types';
import { currencySymbol } from '@/lib/format';
import { useCart } from '@/lib/cart';

interface Props {
  categories: CategoryDto[];
  settings: PublicSettingsDto | null;
}

/** URL категории: корень `catalog` ведёт на индекс /catalog. */
function categoryHref(slug: string): string {
  return slug === 'catalog' ? '/catalog' : `/catalog/${slug}`;
}

/**
 * Рекурсивный пункт выезжающего меню (порт menu-block из page_head.twig). Узел с
 * детьми — аккордеон (.menu-block.open) с внутренним списком: «Все» + дети, где
 * дети со своими детьми разворачиваются такими же вложенными menu-block.
 */
function MenuNode({ node }: { node: CategoryDto }) {
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;

  if (!hasChildren) {
    return (
      <div className="menu-block">
        <div className="menu-block-head">
          <a href={categoryHref(node.slug)}>{node.name}</a>
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
        <a href={categoryHref(node.slug)} onClick={(e) => e.stopPropagation()}>
          {node.name}
        </a>
        <span className="menu-block-head--plus">+</span>
        <span className="menu-block-head--minus">—</span>
      </div>
      <div className="menu-block-links">
        <a href={categoryHref(node.slug)}>Все</a>
        {node.children.map((child) =>
          child.children.length > 0 ? (
            <MenuNode key={child.slug} node={child} />
          ) : (
            <a key={child.slug} href={categoryHref(child.slug)}>
              {child.name}
            </a>
          ),
        )}
      </div>
    </div>
  );
}

export default function SiteHeader({ categories, settings }: Props) {
  const { count, mounted } = useCart();

  const setBodyMenu = (on: boolean) => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('page-menu-open', on);
    }
  };

  const email = settings?.contacts.email ?? settings?.branding.supportEmail ?? '';
  const phone = settings?.contacts.phone ?? settings?.branding.supportPhone ?? '';
  const sign = currencySymbol(settings?.currency.code, settings?.currency.symbol);

  return (
    <>
      <div className="page-head">
        <div className="burger js-menu-open" onClick={() => setBodyMenu(true)}>
          <div />
          <div />
        </div>
        <div className="page-head-logo">
          <a href="/">
            <img src="/images/logo.svg" alt={settings?.branding.shopName ?? 'carre'} />
          </a>
        </div>
        <div className="page-head-settings">
          <div className="page-head-settings__item">
            <div className="page-head-settings__dd">
              <div className="page-head-settings__dd-item" data-label="₽">Рубли</div>
              <div className="page-head-settings__dd-item" data-label="€">Euro</div>
            </div>
            <span className="page-head-label">{sign || '₽'}</span>
            <span className="page-head-chevron">⌄</span>
          </div>
          <div className="page-head-settings__item">
            <div className="page-head-settings__dd">
              <div className="page-head-settings__dd-item" data-label="Рус">Русский</div>
              <div className="page-head-settings__dd-item" data-label="Eng">English</div>
              <div className="page-head-settings__dd-item" data-label="Fra">Français</div>
            </div>
            Рус
            <span className="page-head-chevron">⌄</span>
          </div>
        </div>
        <div className="page-head-icons">
          <a href="/search"><img src="/images/search.svg" alt="" /></a>
          <a href="/favorite"><img src="/images/heart.svg" alt="" /></a>
          <a href="/cart">
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
              <form action="/search">
                <input type="text" name="q" placeholder="Что вы ищете?" />
              </form>
            </div>
            {categories.map((cat) => (
              <MenuNode key={cat.slug} node={cat} />
            ))}
            <div className="menu-block">
              <div className="menu-block-head">
                <a href="/about">О нас</a>
              </div>
            </div>
            <div className="menu-block" />
          </div>
          <div className="page-menu-top-links">
            <a href="/corporate">Корпоративным клиентам</a>
            <a href="/certificates">Подарочные сертификаты</a>
          </div>
          <div className="page-menu-top-links">
            <a href="/favorite">Избранное</a>
            <a href="/cart">Корзина</a>
            <a href="/contacts">Контакты</a>
          </div>
        </div>
        <div className="page-menu-footer">
          {email && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">Для покупателей</div>
              <div className="page-menu-footer-item--info">
                <a href={`mailto:${email}`}>{email}</a>
              </div>
            </div>
          )}
          {phone && (
            <div className="page-menu-footer-item">
              <div className="page-menu-footer-item--name">Тел. / Whatsapp</div>
              <div className="page-menu-footer-item--info">
                <a href={`tel:${phone}`}>{phone}</a>
              </div>
            </div>
          )}
          <div className="page-menu-footer-item">
            <div className="mm-row">
              <div className="mm-langs">
                <span className="mm-langs__item mm-langs__item--active">Ru</span>
                <span className="mm-langs__item">Eng</span>
                <span className="mm-langs__item">Fra</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
