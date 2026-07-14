import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardCustomers, customerStatusLabel, customerStatusBadgeClass } from '../_components/guard';
import { getCustomerById, listCustomerOrders } from '@/lib/customer-auth/repository';
import { orderStatusLabel, paymentStatusLabel } from '@/lib/orders/labels';
import { formatDateTime } from '@/lib/admin/order-format';

/**
 * Карточка покупателя (docs/24 §6): профиль (read-only) + список заказов. Правки
 * паролей/статусов здесь НЕТ (7a — просмотр, customers.read). password_hash в
 * репозитории не читается и на страницу не попадает.
 */
export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardCustomers();
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const customer = await getCustomerById(id);
  if (!customer) {
    notFound();
  }

  const orders = await listCustomerOrders(customer.id, { limit: 100 });

  return (
    <div className="max-w-4xl">
      <PageHeader
        title={customer.email}
        subtitle="Аккаунт покупателя — просмотр"
        breadcrumbs={[
          { label: 'Покупатели', href: '/admin/customers' },
          { label: customer.email },
        ]}
      />

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Профиль</h2>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <dt className="text-gray-500">Email</dt>
          <dd>{customer.email}</dd>
          <dt className="text-gray-500">Имя</dt>
          <dd>{customer.name || '—'}</dd>
          <dt className="text-gray-500">Телефон</dt>
          <dd>{customer.phone || '—'}</dd>
          <dt className="text-gray-500">Статус</dt>
          <dd>
            <span
              className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${customerStatusBadgeClass(customer.status)}`}
            >
              {customerStatusLabel(customer.status)}
            </span>
          </dd>
          <dt className="text-gray-500">Email подтверждён</dt>
          <dd>{customer.emailVerifiedAt ? formatDateTime(customer.emailVerifiedAt) : '—'}</dd>
          <dt className="text-gray-500">Язык</dt>
          <dd>{customer.preferredLocale || '—'}</dd>
          <dt className="text-gray-500">Последний вход</dt>
          <dd>{customer.lastLoginAt ? formatDateTime(customer.lastLoginAt) : '—'}</dd>
          <dt className="text-gray-500">Регистрация</dt>
          <dd>{formatDateTime(customer.createdAt)}</dd>
          <dt className="text-gray-500">Заказов / сумма</dt>
          <dd>
            {customer.ordersCount} / {customer.totalSpent}
          </dd>
        </dl>
      </section>

      <section className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Заказы</h2>
        {orders.length === 0 ? (
          <p className="text-sm text-gray-600">У покупателя пока нет привязанных заказов.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">Номер</th>
                  <th className="px-4 py-2 font-medium">Дата</th>
                  <th className="px-4 py-2 font-medium">Статус</th>
                  <th className="px-4 py-2 font-medium">Оплата</th>
                  <th className="px-4 py-2 font-medium">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.number} className="border-t border-gray-100">
                    <td className="px-4 py-2">
                      <Link href={`/admin/orders`} className="text-blue-700 hover:underline">
                        {o.number}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                      {formatDateTime(o.createdAt)}
                    </td>
                    <td className="px-4 py-2">{orderStatusLabel(o.status)}</td>
                    <td className="px-4 py-2">{paymentStatusLabel(o.paymentStatus)}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-gray-700">
                      {o.grandTotal} {o.currency}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
