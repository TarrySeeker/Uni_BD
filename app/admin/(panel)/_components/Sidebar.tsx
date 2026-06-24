'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import type { NavItem } from '@/lib/admin/nav';

/**
 * Боковая навигация админки. Получает уже отфильтрованный по модулям и правам
 * список пунктов (buildAdminNav) — сам решений о доступе не принимает.
 *
 * Клиентский компонент:
 *  - подсвечивает АКТИВНЫЙ раздел по текущему пути (usePathname, aria-current);
 *  - адаптив: на десктопе (md+) — статичная колонка w-60; на телефоне — кнопка
 *    «☰ Меню» и выезжающая панель (drawer) поверх контента, закрывается по
 *    выбору пункта или фону. Раньше меню было фиксированной ширины без мобильной
 *    версии и «съедало» пол-экрана на телефоне.
 *
 * Лейаут оборачивает это в `flex flex-col md:flex-row`, поэтому на мобиле бар
 * меню стоит над контентом, на десктопе — колонкой слева.
 */
export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  function isActive(href: string): boolean {
    if (href === '/admin') return pathname === '/admin';
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function linkClass(active: boolean): string {
    return `block rounded-md px-3 py-2 text-sm font-medium ${
      active
        ? 'bg-gray-900 text-white'
        : 'text-gray-700 hover:bg-gray-200 hover:text-gray-900'
    }`;
  }

  const links = (onClick?: () => void) => (
    <ul className="flex flex-col gap-1">
      {items.map((item) => {
        const active = isActive(item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? 'page' : undefined}
              onClick={onClick}
              className={linkClass(active)}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      {/* Десктоп: статичная колонка */}
      <nav
        aria-label="Основная навигация"
        className="hidden w-60 shrink-0 border-r border-gray-200 bg-gray-50 p-4 md:block"
      >
        {links()}
      </nav>

      {/* Мобайл: бар с кнопкой «Меню» */}
      <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Открыть меню"
          aria-expanded={open}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700"
        >
          <span aria-hidden="true">☰</span> Меню
        </button>
      </div>

      {/* Мобайл: выезжающая панель */}
      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <nav
            aria-label="Основная навигация"
            className="absolute left-0 top-0 h-full w-64 max-w-[80%] overflow-y-auto border-r border-gray-200 bg-white p-4 shadow-xl"
          >
            <div className="mb-3 flex justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Закрыть меню"
                className="rounded-md px-2 py-1 text-sm text-gray-500 hover:bg-gray-100"
              >
                ✕
              </button>
            </div>
            {links(() => setOpen(false))}
          </nav>
        </div>
      ) : null}
    </>
  );
}
