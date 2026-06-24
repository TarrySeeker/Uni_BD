import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Единая шапка страницы админки: хлебные крошки + кнопка «← Назад» + заголовок +
 * (опц.) подзаголовок + слот основного действия справа.
 *
 * Зачем: владелец жаловался, что «нельзя вернуться назад» и навигация неудобна.
 * Раньше хлебные крошки/«Назад» были добавлены точечно и непоследовательно (на
 * списках верхнего уровня их не было вовсе). Этот компонент даёт единый,
 * предсказуемый способ навигации на КАЖДОЙ странице:
 *  - крошки всегда начинаются с «Админка» (→ дашборд), затем путь раздела;
 *  - кнопка «← Назад» (backHref) — заметная, не теряется среди текста;
 *  - слот action — для основной кнопки страницы (напр. «Создать товар»).
 */

export interface Crumb {
  label: string;
  /** Если задан — крошка кликабельна. Последняя крошка обычно без href. */
  href?: string;
}

export function PageHeader({
  title,
  subtitle,
  breadcrumbs = [],
  backHref,
  backLabel = 'Назад',
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  breadcrumbs?: Crumb[];
  backHref?: string;
  backLabel?: string;
  action?: ReactNode;
}) {
  // «Админка» (дашборд) — всегда первой крошкой, чтобы с любой страницы был путь
  // на верхний уровень одним кликом.
  const crumbs: Crumb[] = [{ label: 'Админка', href: '/admin' }, ...breadcrumbs];

  return (
    <div className="mb-6">
      <nav aria-label="Хлебные крошки" className="text-sm text-gray-500">
        <ol className="flex flex-wrap items-center gap-1">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={`${c.label}-${i}`} className="flex items-center gap-1">
                {c.href && !last ? (
                  <Link href={c.href} className="text-blue-700 hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span className={last ? 'text-gray-700' : ''}>{c.label}</span>
                )}
                {!last ? <span className="text-gray-300">/</span> : null}
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {backHref ? (
            <Link
              href={backHref}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-100"
            >
              <span aria-hidden="true">←</span> {backLabel}
            </Link>
          ) : null}
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-gray-600">{subtitle}</p> : null}
          </div>
        </div>
        {action ? <div className="flex items-center gap-2">{action}</div> : null}
      </div>
    </div>
  );
}
