/**
 * Репозиторий подписчиков рассылки (G-12). Подписка идемпотентна (ON CONFLICT
 * DO NOTHING по уникальному email). Чтение/счётчик — для админки.
 */
import { sql } from '@/lib/db/client';

export interface SubscriberRow {
  id: string;
  email: string;
  status: string;
  created_at: Date;
}

/** Подписывает email (идемпотентно). Не раскрывает, был ли уже подписан. */
export async function subscribe(email: string): Promise<void> {
  await sql`
    INSERT INTO newsletter_subscribers (email)
    VALUES (${email})
    ON CONFLICT (email) DO NOTHING
  `;
}

/** Список подписчиков (новые сверху) для админки. */
export async function listSubscribers(limit = 500): Promise<SubscriberRow[]> {
  return sql<SubscriberRow[]>`
    SELECT id, email, status, created_at
    FROM newsletter_subscribers
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/** Число активных подписчиков. */
export async function countActiveSubscribers(): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM newsletter_subscribers WHERE status = 'active'
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Общее число подписчиков (active + unsubscribed). Нужно для «X из N» и плашки
 * усечения списка (находка #9): listSubscribers отдаёт смешанный список, поэтому
 * countActiveSubscribers для тотала не годится.
 */
export async function countSubscribers(): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM newsletter_subscribers
  `;
  return Number(rows[0]?.count ?? 0);
}

/**
 * Отписывает подписчика (status='unsubscribed'). GUARDED `AND status = 'active'`:
 * повторная отписка/несуществующий id вернут 0 строк (идемпотентно, без ложного
 * успеха). Возвращает строку при реальном переходе active→unsubscribed, иначе
 * null. Решение «не найден / уже отписан» принимает вызывающий action.
 */
export async function unsubscribe(id: string): Promise<SubscriberRow | null> {
  const rows = await sql<SubscriberRow[]>`
    UPDATE newsletter_subscribers
       SET status = 'unsubscribed'
     WHERE id = ${id} AND status = 'active'
    RETURNING id, email, status, created_at
  `;
  return rows[0] ?? null;
}
