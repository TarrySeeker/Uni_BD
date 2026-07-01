/**
 * Репозиторий заявок (G-09). Запись — с витрины (insertLead), чтение/счётчик —
 * в админке. Параметризованный sql (postgres.js), без бизнес-логики.
 */
import { sql } from '@/lib/db/client';

export interface LeadRow {
  id: string;
  name: string;
  contact: string;
  message: string;
  source: string;
  status: string;
  created_at: Date;
}

/** Сохраняет заявку, возвращает её id. */
export async function insertLead(input: {
  name: string;
  contact: string;
  message: string;
  source?: string;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO leads (name, contact, message, source)
    VALUES (${input.name}, ${input.contact}, ${input.message}, ${input.source ?? 'contact_form'})
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

/** Список заявок (новые сверху) для админки. */
export async function listLeads(limit = 200): Promise<LeadRow[]> {
  return sql<LeadRow[]>`
    SELECT id, name, contact, message, source, status, created_at
    FROM leads
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/** Число необработанных заявок (status='new') — для бейджа/дашборда. */
export async function countNewLeads(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM leads WHERE status = 'new'`;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Общее число заявок (все статусы) — для «Всего: N» и плашки усечения списка
 * (C7), зеркало countSubscribers: listLeads отдаёт усечённый по LIMIT список,
 * поэтому для тотала нужен отдельный count.
 */
export async function countLeads(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM leads`;
  return Number(rows[0]?.count ?? 0);
}

/** Текущий статус заявки (null — заявка не найдена). Для before-снимка/гварда перехода. */
export async function getLeadStatus(id: string): Promise<string | null> {
  const rows = await sql<{ status: string }[]>`SELECT status FROM leads WHERE id = ${id} LIMIT 1`;
  return rows[0]?.status ?? null;
}

/** Меняет статус заявки. Возвращает true, если строка найдена и обновлена. */
export async function updateLeadStatus(id: string, status: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE leads SET status = ${status} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

/** Удаляет заявку. Возвращает true, если строка существовала. */
export async function deleteLead(id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`DELETE FROM leads WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}
