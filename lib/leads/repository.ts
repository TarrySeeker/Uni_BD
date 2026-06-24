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
