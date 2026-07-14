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
  /** Организация клиента (§9, ← b_os_feedback); null для старых/простых заявок. */
  company: string | null;
  /** Город клиента (§9); null если не заполнен. */
  city: string | null;
  /** Тема обращения (§9); null если не заполнена. */
  subject: string | null;
  /** Ответ оператора (§9); null пока не отвечено. */
  answer: string | null;
  /** S3-ключ вложения (§9); null без вложения. URL/скачивание — через storage. */
  attachment_key: string | null;
  created_at: Date;
}

/** Сохраняет заявку, возвращает её id. Доп. поля (§9) опциональны — старая форма
 *  их не шлёт, колонки остаются NULL (обратная совместимость). */
export async function insertLead(input: {
  name: string;
  contact: string;
  message: string;
  source?: string;
  company?: string | null;
  city?: string | null;
  subject?: string | null;
  attachmentKey?: string | null;
}): Promise<{ id: string }> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO leads (name, contact, message, source, company, city, subject, attachment_key)
    VALUES (
      ${input.name}, ${input.contact}, ${input.message}, ${input.source ?? 'contact_form'},
      ${input.company ?? null}, ${input.city ?? null}, ${input.subject ?? null},
      ${input.attachmentKey ?? null}
    )
    RETURNING id
  `;
  return { id: rows[0]!.id };
}

/** Список заявок (новые сверху) для админки. */
export async function listLeads(limit = 200): Promise<LeadRow[]> {
  return sql<LeadRow[]>`
    SELECT id, name, contact, message, source, status,
           company, city, subject, answer, attachment_key, created_at
    FROM leads
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/** Одна заявка по id (полная строка) — для карточки/ответа оператора. */
export async function getLead(id: string): Promise<LeadRow | null> {
  const rows = await sql<LeadRow[]>`
    SELECT id, name, contact, message, source, status,
           company, city, subject, answer, attachment_key, created_at
    FROM leads WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Записывает ответ оператора (§9). Пустой ответ (после trim) → NULL (снять
 * ответ). Возвращает true, если строка найдена и обновлена.
 */
export async function updateLeadAnswer(id: string, answer: string | null): Promise<boolean> {
  const normalized = answer && answer.trim() !== '' ? answer : null;
  const rows = await sql<{ id: string }[]>`
    UPDATE leads SET answer = ${normalized} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
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
