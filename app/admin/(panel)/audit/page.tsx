import Link from 'next/link';

import { requireUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { sql } from '@/lib/db/client';
import { auditActionLabel, auditEntityTypeLabel } from '@/lib/admin/audit-labels';
import {
  parseAuditFilters,
  auditFilterBounds,
  type AuditFilter,
} from '@/lib/admin/audit-filters';
import { diffAuditData } from '@/lib/admin/audit-diff';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { AuditFilters } from './_components/AuditFilters';

/**
 * Просмотр журнала аудита (docs/04 §7, задача 1.4/1.5). Под правом 'audit.read'.
 *
 * Сервер — единственный источник решения о доступе: проверяем can() и при
 * отсутствии права рендерим 403 (UI-скрытие в меню защитой не является, §5.3).
 *
 * Читаемость (находка #17): колонка «Действие» показывает русскую подпись
 * (auditActionLabel), а не сырой код; «Сущность» — русский тип + понятное имя
 * (email пользователя / название роли), uuid уезжает в tooltip. Жёсткий LIMIT=100
 * заменён offset-пагинацией с общим счётчиком, чтобы старые записи были доступны.
 *
 * Тупики docs/20: C1 — фильтры по дате/действию/инициатору/сущности (WHERE
 * применяется ОДИНАКОВО к count и к выборке, фильтры сохраняются в пагинации);
 * C0 — дифф before_data/after_data в нативном <details>; C11 — IP и user_agent
 * инициатора (host(ip) → текст). Загрузка строк вынесена в loadAuditRows.
 *
 * force-dynamic: страница читает БД и сессию — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

/** Размер страницы журнала (offset-пагинация). */
const PAGE_SIZE = 50;

/** UUID v4-подобный (анти-cast-error: в ::uuid[] пускаем только валидные id). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Строка журнала для таблицы. */
interface AuditRow {
  id: string;
  created_at: Date;
  actor_email: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
}

/** Форматирует время записи в локали ru (московское время — привычнее владельцу). */
function formatTime(value: Date): string {
  return new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
}

/** Короткий вид uuid для подписи (полный — в title-tooltip). */
function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** Компактное представление произвольного значения снимка для ячейки диффа. */
function formatDiffValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/**
 * Загрузка отфильтрованной страницы журнала (тупик C11 — вынесено в чистую
 * функцию для контракта; round-trip ip/user_agent зафиксирован в
 * tests/audit/log.test.ts через host(ip)). Параметризованный SQL: значения биндит
 * postgres.js, склейки строк нет (анти-SQLi). Один и тот же фрагмент `where` идёт
 * в count и в выборку → totalPages совпадает.
 *
 * Сначала считаем total, затем клампим страницу (overshoot ?page показывает
 * последнюю реальную страницу, а не пустую таблицу — фикс ревью Batch 6) и только
 * после этого тянем строки с корректным offset.
 */
export async function loadAuditRows(
  filter: AuditFilter,
  pageSize: number,
): Promise<{ rows: AuditRow[]; total: number; currentPage: number; totalPages: number }> {
  const b = auditFilterBounds(filter);
  const where = sql`
    WHERE (${b.action}::text IS NULL OR action = ${b.action})
      AND (${b.entityType}::text IS NULL OR entity_type = ${b.entityType})
      AND (${b.actorLike}::text IS NULL OR actor_email ILIKE ${b.actorLike})
      AND (${b.dateFrom}::timestamptz IS NULL OR created_at >= ${b.dateFrom})
      AND (${b.dateTo}::timestamptz IS NULL OR created_at < ${b.dateTo})
  `;

  const totalRows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n FROM audit_log ${where}
  `;
  const total = Number(totalRows[0]?.n ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(filter.page, totalPages);
  const offset = (currentPage - 1) * pageSize;

  const rows = await sql<AuditRow[]>`
    SELECT id, created_at, actor_email, action, entity_type, entity_id,
           before_data, after_data, host(ip) AS ip, user_agent
    FROM audit_log ${where}
    ORDER BY created_at DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `;

  return { rows, total, currentPage, totalPages };
}

/**
 * Подтягивает понятные имена сущностей по id: email для пользователей, title для
 * ролей. Возвращает Map<entity_id, name>. Только для валидных uuid (cast-safe).
 */
async function resolveEntityNames(rows: AuditRow[]): Promise<Map<string, string>> {
  const collect = (type: string): string[] => [
    ...new Set(
      rows
        .filter((r) => r.entity_type === type && r.entity_id && UUID_RE.test(r.entity_id))
        .map((r) => r.entity_id as string),
    ),
  ];
  const userIds = collect('user');
  const roleIds = collect('role');

  const [userRows, roleRows] = await Promise.all([
    userIds.length
      ? sql<{ id: string; email: string }[]>`
          SELECT id::text AS id, email FROM users WHERE id = ANY(${userIds}::uuid[])
        `
      : Promise.resolve([] as { id: string; email: string }[]),
    roleIds.length
      ? sql<{ id: string; title: string }[]>`
          SELECT id::text AS id, title FROM roles WHERE id = ANY(${roleIds}::uuid[])
        `
      : Promise.resolve([] as { id: string; title: string }[]),
  ]);

  const map = new Map<string, string>();
  for (const u of userRows) map.set(u.id, u.email);
  for (const r of roleRows) map.set(r.id, r.title);
  return map;
}

/** Сохраняет текущие фильтры, меняя только page (для ссылок пагинации). */
function pageHref(
  sp: Record<string, string | string[] | undefined>,
  page: number,
): string {
  const next = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (k === 'page') continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (value) next.set(k, value);
  }
  next.set('page', String(page));
  return `/admin/audit?${next.toString()}`;
}

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  if (!can(user, 'audit.read')) {
    return <Forbidden permission="audit.read" />;
  }

  const sp = await searchParams;
  const filter = parseAuditFilters(sp);

  const { rows, total, currentPage, totalPages } = await loadAuditRows(filter, PAGE_SIZE);
  const names = await resolveEntityNames(rows);

  return (
    <div>
      <PageHeader
        title="Журнал аудита"
        subtitle={`Всего событий: ${total}. Страница ${currentPage} из ${totalPages}.`}
        breadcrumbs={[{ label: 'Аудит' }]}
      />

      <div className="mt-4">
        <AuditFilters />
      </div>

      <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50 text-left text-gray-500">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Время (МСК)</th>
              <th scope="col" className="px-4 py-2 font-medium">Инициатор</th>
              <th scope="col" className="px-4 py-2 font-medium">Действие</th>
              <th scope="col" className="px-4 py-2 font-medium">Сущность</th>
              <th scope="col" className="px-4 py-2 font-medium">Изменения</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-gray-400">
                  Записей пока нет.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const name = row.entity_id ? names.get(row.entity_id) : undefined;
                const diff =
                  row.before_data || row.after_data
                    ? diffAuditData(row.before_data, row.after_data)
                    : [];
                return (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-4 py-2 text-gray-700">
                      {formatTime(row.created_at)}
                    </td>
                    <td className="px-4 py-2 text-gray-700" title={row.user_agent ?? undefined}>
                      <span>{row.actor_email ?? '—'}</span>
                      {row.ip ? (
                        <span className="block text-xs text-gray-400">{row.ip}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-gray-800" title={row.action}>
                      {auditActionLabel(row.action)}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {row.entity_type ? (
                        <span>
                          <span className="text-gray-500">
                            {auditEntityTypeLabel(row.entity_type)}
                          </span>
                          {name ? (
                            <span className="ml-1 text-gray-900">{name}</span>
                          ) : row.entity_id ? (
                            <code
                              className="ml-1 rounded bg-gray-100 px-1 py-0.5 text-xs text-gray-400"
                              title={row.entity_id}
                            >
                              {shortId(row.entity_id)}
                            </code>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {diff.length > 0 ? (
                        <details>
                          <summary className="cursor-pointer text-blue-700 hover:underline">
                            Подробнее ({diff.length})
                          </summary>
                          <table className="mt-2 border-collapse text-xs">
                            <thead className="text-left text-gray-400">
                              <tr>
                                <th className="pr-3 font-medium">Поле</th>
                                <th className="pr-3 font-medium">Было</th>
                                <th className="font-medium">Стало</th>
                              </tr>
                            </thead>
                            <tbody>
                              {diff.map((d) => (
                                <tr key={d.key} className="align-top">
                                  <td className="pr-3 font-mono text-gray-700">{d.key}</td>
                                  <td className="pr-3 text-gray-500">
                                    {formatDiffValue(d.from)}
                                  </td>
                                  <td className="text-gray-900">{formatDiffValue(d.to)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </details>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                );
              })
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
                href={pageHref(sp, currentPage - 1)}
                className="rounded border border-gray-300 px-3 py-1.5 hover:bg-gray-100"
              >
                Назад
              </Link>
            ) : null}
            {currentPage < totalPages ? (
              <Link
                href={pageHref(sp, currentPage + 1)}
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
