import Link from 'next/link';

import { sql } from '@/lib/db/client';
import { isCdekMock, getCdekConfig } from '@/lib/cdek/config';
import { deliveryModeLabel, destinationLabel } from '@/lib/cdek/format';
import { formatDateTime } from '@/lib/admin/order-format';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardCdek } from './_components/guard';

/**
 * Раздел «Доставка (СДЭК)» админки — сводка отправлений по всем заказам.
 *
 * Закрывает 404 пункта меню «Доставка» (`/admin/cdek`): per-order действия СДЭК
 * (создать накладную / отменить / обновить статус / печать) живут в карточке
 * заказа (`CdekBlock`), а этот раздел даёт общий обзор всех отправлений магазина
 * с фильтром-поиском и пагинацией. Доступ — guardCdek (модуль `cdek` + право
 * `cdek.manage`). Чтение — параметризованный sql во view-слое (как orders/page).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

/** Режим работы модуля СДЭК для бейджа-шапки (mock / тестовый контур / боевой). */
function cdekMode(): { label: string; cls: string; hint: string } {
  if (isCdekMock()) {
    return {
      label: 'MOCK',
      cls: 'bg-amber-100 text-amber-800 border-amber-200',
      hint: 'Боевые ключи не заданы — реальные отправления не создаются.',
    };
  }
  const cfg = getCdekConfig();
  const isTest = cfg.testMode || /\bedu\./.test(cfg.baseUrl);
  if (isTest) {
    return {
      label: 'Тестовый контур (edu)',
      cls: 'bg-blue-100 text-blue-800 border-blue-200',
      hint: 'Запросы идут на sandbox СДЭК (api.edu.cdek.ru). Отправления — тестовые.',
    };
  }
  return {
    label: 'Боевой контур',
    cls: 'bg-green-100 text-green-800 border-green-200',
    hint: 'Запросы идут на боевой API СДЭК. Создаются реальные отправления.',
  };
}

interface ShipmentRow {
  id: string;
  cdek_number: string | null;
  cdek_uuid: string | null;
  delivery_mode: string | null;
  pvz_code: string | null;
  status_code: string | null;
  status_name: string | null;
  status_at: Date | null;
  is_mock: boolean;
  error: string | null;
  updated_at: Date;
  print_url: string | null;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_email: string | null;
  delivery_city: string | null;
  delivery_pvz_code: string | null;
}

async function loadShipments(
  q: string | undefined,
  page: number,
): Promise<{ rows: ShipmentRow[]; total: number }> {
  const like = q ? `%${q}%` : null;
  const offset = (page - 1) * PAGE_SIZE;

  const where = sql`
    WHERE (${like}::text IS NULL OR s.cdek_number ILIKE ${like} OR o.number ILIKE ${like})
  `;

  const [totalRows, rows] = await Promise.all([
    sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM cdek_shipments s JOIN orders o ON o.id = s.order_id ${where}
    `,
    sql<ShipmentRow[]>`
      SELECT
        s.id, s.cdek_number, s.cdek_uuid, s.delivery_mode, s.pvz_code,
        s.status_code, s.status_name, s.status_at, s.is_mock, s.error,
        s.updated_at, s.print_url,
        o.id AS order_id, o.number AS order_number,
        o.customer_name, o.customer_email,
        o.delivery_city, o.delivery_pvz_code
      FROM cdek_shipments s JOIN orders o ON o.id = s.order_id ${where}
      ORDER BY s.updated_at DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `,
  ]);

  return { rows, total: Number(totalRows[0]?.n ?? 0) };
}

export default async function CdekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const guard = await guardCdek('cdek.manage');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="доставка СДЭК (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const sp = await searchParams;
  const qRaw = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const q = qRaw?.trim() || undefined;
  const pageRaw = Number(Array.isArray(sp.page) ? sp.page[0] : sp.page ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const mode = cdekMode();
  const { rows, total } = await loadShipments(q, page);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const pageHref = (p: number): string => {
    const next = new URLSearchParams();
    if (q) next.set('q', q);
    next.set('page', String(p));
    return `/admin/cdek?${next.toString()}`;
  };

  return (
    <div>
      <PageHeader
        title="Доставка (СДЭК)"
        subtitle={`Найдено отправлений: ${total}.`}
        breadcrumbs={[{ label: 'Доставка' }]}
        action={
          <div className="text-right">
            <span
              className={`inline-block rounded-full border px-3 py-1 text-xs font-medium ${mode.cls}`}
            >
              {mode.label}
            </span>
            <p className="mt-1 max-w-xs text-xs text-gray-400">{mode.hint}</p>
          </div>
        }
      />

      <form method="get" className="mt-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Поиск: трек-номер или номер заказа"
          className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100"
        >
          Найти
        </button>
        {q ? (
          <Link
            href="/admin/cdek"
            className="rounded-md px-4 py-2 text-sm font-medium text-gray-500 hover:bg-gray-100"
          >
            Сбросить
          </Link>
        ) : null}
      </form>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Трек-номер</th>
              <th scope="col" className="px-4 py-2 font-medium">Заказ</th>
              <th scope="col" className="px-4 py-2 font-medium">Покупатель</th>
              <th scope="col" className="px-4 py-2 font-medium">Способ</th>
              <th scope="col" className="px-4 py-2 font-medium">Назначение</th>
              <th scope="col" className="px-4 py-2 font-medium">Статус СДЭК</th>
              <th scope="col" className="px-4 py-2 font-medium">Обновлён</th>
              <th scope="col" className="px-4 py-2 font-medium">Печать</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                  Отправлений нет. Накладные СДЭК создаются из карточки заказа
                  (блок «Доставка СДЭК») после успешной оплаты.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <span className="font-medium text-gray-900">
                      {row.cdek_number ?? '—'}
                    </span>
                    {row.is_mock ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                        mock
                      </span>
                    ) : null}
                    {row.error ? (
                      <div className="mt-0.5 text-xs text-red-600">{row.error}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2">
                    <Link
                      href={`/admin/orders/${row.order_id}`}
                      className="font-medium text-blue-700 hover:underline"
                    >
                      {row.order_number}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    <div>{row.customer_name ?? '—'}</div>
                    <div className="text-xs text-gray-400">{row.customer_email}</div>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {deliveryModeLabel(row.delivery_mode)}
                  </td>
                  <td className="px-4 py-2 text-gray-600">{destinationLabel(row)}</td>
                  <td className="px-4 py-2 text-gray-700">
                    {row.status_name ?? row.status_code ?? '—'}
                    {row.status_at ? (
                      <div className="text-xs text-gray-400">
                        {formatDateTime(row.status_at)}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-2 text-gray-500">{formatDateTime(row.updated_at)}</td>
                  <td className="px-4 py-2">
                    {row.print_url ? (
                      row.is_mock ? (
                        // MOCK: print_url ведёт на example.invalid (RFC 2606) и
                        // никогда не откроется — вместо мёртвой ссылки показываем
                        // некликабельный бейдж-пояснение (находка #12).
                        <span
                          className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700"
                          title="MOCK: реальная накладная появится в боевом режиме (с боевыми ключами СДЭК)"
                        >
                          mock
                        </span>
                      ) : (
                        <a
                          href={row.print_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-700 hover:underline"
                        >
                          Накладная
                        </a>
                      )
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 ? (
        <nav className="mt-4 flex items-center justify-between text-sm" aria-label="Пагинация">
          <span className="text-gray-500">
            Страница {currentPage} из {totalPages}
          </span>
          <div className="flex gap-2">
            {currentPage > 1 ? (
              <Link
                href={pageHref(currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Назад
              </Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link
                href={pageHref(currentPage + 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Вперёд
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
