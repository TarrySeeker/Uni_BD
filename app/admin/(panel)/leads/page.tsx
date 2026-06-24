import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardLeads } from './_components/guard';
import { listLeads } from '@/lib/leads/repository';
import { formatDateTime } from '@/lib/admin/order-format';

/**
 * Раздел «Заявки» (G-09): сообщения с формы обратной связи витрины. Доступ —
 * guardLeads (право orders.read). force-dynamic: читает БД/cookies.
 */
export const dynamic = 'force-dynamic';

export default async function LeadsPage() {
  const guard = await guardLeads();
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  const leads = await listLeads(200);

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Заявки"
        subtitle="Сообщения с формы обратной связи витрины (/contacts)."
        breadcrumbs={[{ label: 'Заявки' }]}
      />

      {leads.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">Пока нет заявок.</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-4 py-2 font-medium">Дата</th>
                <th className="px-4 py-2 font-medium">Имя</th>
                <th className="px-4 py-2 font-medium">Контакт</th>
                <th className="px-4 py-2 font-medium">Сообщение</th>
                <th className="px-4 py-2 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-gray-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">{formatDateTime(l.created_at)}</td>
                  <td className="px-4 py-2">{l.name}</td>
                  <td className="px-4 py-2">{l.contact}</td>
                  <td className="px-4 py-2 text-gray-700">{l.message}</td>
                  <td className="px-4 py-2 text-gray-500">{l.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
