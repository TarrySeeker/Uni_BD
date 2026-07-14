import Link from 'next/link';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardCustomers, customerStatusLabel, customerStatusBadgeClass } from './_components/guard';
import { listCustomers, countCustomers } from '@/lib/customer-auth/repository';
import { formatDateTime } from '@/lib/admin/order-format';
import { listTruncationNotice } from '@/lib/admin/list-truncation';

/**
 * Раздел «Покупатели» (docs/24 §6): аккаунты покупателей витрины (просмотр/
 * поддержка). Доступ — guardCustomers (право customers.read, модуль account).
 * force-dynamic: читает БД/cookies. Пароли отсюда НЕ управляются (7a — просмотр).
 */
export const dynamic = 'force-dynamic';

const LIST_LIMIT = 200;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const guard = await guardCustomers();
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const { q } = await searchParams;
  const query = (q ?? '').trim();

  const [customers, total] = await Promise.all([
    listCustomers({ q: query, limit: LIST_LIMIT }),
    countCustomers({ q: query }),
  ]);
  const truncation = listTruncationNotice(customers.length, total, LIST_LIMIT);

  return (
    <div className="max-w-6xl">
      <PageHeader
        title="Покупатели"
        subtitle={`Аккаунты и гостевые контакты витрины. Всего: ${total}.`}
        breadcrumbs={[{ label: 'Покупатели' }]}
      />

      <form method="get" className="mt-4 flex gap-2">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Поиск по email, имени, телефону"
          className="w-72 rounded border border-gray-300 px-3 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="rounded bg-gray-900 px-3 py-1.5 text-sm font-medium text-white"
        >
          Найти
        </button>
      </form>

      {truncation ? (
        <p
          role="status"
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {truncation}.
        </p>
      ) : null}

      {customers.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">Покупателей не найдено.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Имя</th>
                <th className="px-4 py-2 font-medium">Статус</th>
                <th className="px-4 py-2 font-medium">Заказов</th>
                <th className="px-4 py-2 font-medium">Сумма</th>
                <th className="px-4 py-2 font-medium">Последний вход</th>
                <th className="px-4 py-2 font-medium">Регистрация</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-t border-gray-100 align-top">
                  <td className="px-4 py-2">
                    <Link href={`/admin/customers/${c.id}`} className="text-blue-700 hover:underline">
                      {c.email}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{c.name || '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${customerStatusBadgeClass(c.status)}`}
                    >
                      {customerStatusLabel(c.status)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{c.ordersCount}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-700">{c.totalSpent}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : '—'}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatDateTime(c.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
