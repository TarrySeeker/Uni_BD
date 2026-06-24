import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { sql } from '@/lib/db/client';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';

/**
 * Просмотр журнала аудита (docs/04 §7, задача 1.4/1.5). Последние N записей,
 * простая таблица: время / actor / action / entity. Под правом 'audit.read'.
 *
 * Сервер — единственный источник решения о доступе: проверяем can() и при
 * отсутствии права рендерим 403 (UI-скрытие в меню защитой не является, §5.3).
 *
 * force-dynamic: страница читает БД и сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

/** Сколько последних записей показываем (пагинация — позже). */
const LIMIT = 100;

/** Строка журнала для таблицы. */
interface AuditRow {
  id: string;
  created_at: Date;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
}

/** Форматирует время записи в локали ru (московское время — привычнее владельцу). */
function formatTime(value: Date): string {
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

export default async function AuditPage() {
  const user = await requireUser();
  if (!can(user, 'audit.read')) {
    return <Forbidden permission="audit.read" />;
  }

  const rows = await sql<AuditRow[]>`
    SELECT id, created_at, actor_email, action, entity_type, entity_id
    FROM audit_log
    ORDER BY created_at DESC
    LIMIT ${LIMIT}
  `;

  return (
    <div>
      <PageHeader
        title="Журнал аудита"
        subtitle={`Последние ${LIMIT} событий (по убыванию времени).`}
        breadcrumbs={[{ label: 'Аудит' }]}
      />

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Время (МСК)</th>
              <th scope="col" className="px-4 py-2 font-medium">Инициатор</th>
              <th scope="col" className="px-4 py-2 font-medium">Действие</th>
              <th scope="col" className="px-4 py-2 font-medium">Сущность</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-gray-400">
                  Записей пока нет.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-2 text-gray-700">
                    {formatTime(row.created_at)}
                  </td>
                  <td className="px-4 py-2 text-gray-700">
                    {row.actor_email ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-800">
                      {row.action}
                    </code>
                  </td>
                  <td className="px-4 py-2 text-gray-600">
                    {row.entity_type
                      ? `${row.entity_type}${row.entity_id ? `: ${row.entity_id}` : ''}`
                      : '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
