import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { guardLeads } from './_components/guard';
import { LeadStatusBadge } from './_components/LeadStatusBadge';
import { LeadRowActions } from './_components/LeadRowActions';
import { ExportToolbar } from './_components/ExportToolbar';
import { listLeads, countLeads } from '@/lib/leads/repository';
import { leadSourceLabel } from '@/lib/leads/schemas';
import { formatDateTime } from '@/lib/admin/order-format';
import { listTruncationNotice } from '@/lib/admin/list-truncation';

/**
 * Раздел «Заявки» (G-09): сообщения с формы обратной связи витрины. Доступ —
 * guardLeads (право orders.read). force-dynamic: читает БД/cookies.
 */
export const dynamic = 'force-dynamic';

/** Сколько заявок показываем (без пагинации). При превышении — плашка усечения. */
const LIST_LIMIT = 200;

export default async function LeadsPage() {
  const guard = await guardLeads();
  if (!guard.ok) {
    return <Forbidden permission={guard.permission} />;
  }

  // Список + общее число читаем параллельно: total нужен для счётчика в шапке и
  // для плашки усечения, чтобы владелец не считал, что заявок ровно столько,
  // сколько влезло в лимит (C7, паттерн подписчиков).
  const [leads, total] = await Promise.all([listLeads(LIST_LIMIT), countLeads()]);
  const truncation = listTruncationNotice(leads.length, total, LIST_LIMIT);

  // Строки для клиентского экспорта (копирование/CSV, C8). Date → ISO для
  // сериализации из Server Component в Client Component (Date приходит строкой).
  const exportRows = leads.map((l) => ({
    id: l.id,
    name: l.name,
    contact: l.contact,
    message: l.message,
    status: l.status,
    createdAtIso: l.created_at.toISOString(),
  }));

  return (
    <div className="max-w-5xl">
      <PageHeader
        title="Заявки"
        subtitle={`Сообщения с формы обратной связи витрины (/contacts). Меняйте статус или удаляйте обработанные. Всего: ${total}.`}
        breadcrumbs={[{ label: 'Заявки' }]}
        action={<ExportToolbar rows={exportRows} />}
      />

      {truncation ? (
        <p
          role="status"
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {truncation}. Используйте экспорт, чтобы получить полный список.
        </p>
      ) : null}

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
                <th className="px-4 py-2 font-medium">Источник</th>
                <th className="px-4 py-2 font-medium">Сообщение</th>
                <th className="px-4 py-2 font-medium">Статус</th>
                <th className="px-4 py-2 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id} className="border-t border-gray-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">{formatDateTime(l.created_at)}</td>
                  <td className="px-4 py-2">{l.name}</td>
                  <td className="px-4 py-2">{l.contact}</td>
                  <td className="px-4 py-2 text-gray-600">{leadSourceLabel(l.source)}</td>
                  <td className="px-4 py-2 text-gray-700">{l.message}</td>
                  <td className="px-4 py-2">
                    <LeadStatusBadge status={l.status} />
                  </td>
                  <td className="px-4 py-2">
                    <LeadRowActions id={l.id} status={l.status} />
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
