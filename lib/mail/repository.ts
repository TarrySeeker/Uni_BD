/**
 * Слой доступа к журналу отправок (таблица mail_log, миграция 0061).
 *
 * Всё через `sql` tagged-templates (параметризация, анти-SQLi) — как
 * lib/orders/repository.ts и lib/cdek/repository.ts.
 *
 * 🔴 ЧЕГО ЗДЕСЬ НЕТ: записи тела письма. Строка журнала — метаданные (кому, что,
 * когда, удалось ли). Код подарочного сертификата в неё не попадает ни через
 * какое поле; при досылке письмо рендерится заново из заказа. Обоснование — в
 * шапке миграции 0061.
 */

import { sql } from '@/lib/db/client';

import type {
  MailJournal,
  MailLogCreateInput,
  MailLogEntry,
  MailLogStatus,
} from './types';

// =============================================================================
// Маппер row → domain.
// =============================================================================

function asDate(v: unknown): Date {
  return v instanceof Date ? v : new Date(v as string);
}

function dateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : asDate(v);
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

/** mail_log row → MailLogEntry. */
export function mapMailLog(row: Record<string, unknown>): MailLogEntry {
  return {
    id: String(row.id),
    recipient: String(row.recipient),
    template: String(row.template),
    locale: strOrNull(row.locale),
    status: String(row.status) as MailLogStatus,
    attempts: Number(row.attempts ?? 0),
    error: strOrNull(row.error),
    subject: strOrNull(row.subject),
    orderId: strOrNull(row.order_id),
    sentAt: dateOrNull(row.sent_at),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/**
 * Список колонок как ФУНКЦИЯ, а не как модульная константа.
 *
 * 🔴 Константа `const COLUMNS = sql\`...\`` вычислялась бы НА ИМПОРТЕ модуля, а
 * `sql` — ленивый Proxy, который при первом обращении поднимает соединение и
 * бросает без DATABASE_URL. Тогда любой юнит-тест, импортирующий отправитель
 * (который импортирует этот файл ради createMailJournal), падал бы ещё до
 * первого it — без единого обращения к БД. Тот же приём применён в
 * lib/gift-certificates/repository.ts (giftColumnsFragment).
 */
function cols() {
  return sql`
    id, recipient, template, locale, status, attempts, error, subject,
    order_id, sent_at, created_at, updated_at
  `;
}

// =============================================================================
// Запись.
// =============================================================================

/** Заводит строку журнала. */
export async function insertMailLog(input: MailLogCreateInput): Promise<MailLogEntry> {
  const rows = await sql<Record<string, unknown>[]>`
    INSERT INTO mail_log (recipient, template, locale, status, attempts, error, subject, order_id)
    VALUES (
      ${input.recipient},
      ${input.template},
      ${input.locale},
      ${input.status},
      ${input.attempts ?? 0},
      ${input.error ?? null},
      ${input.subject ?? null},
      ${input.orderId ?? null}
    )
    RETURNING ${cols()}
  `;
  return mapMailLog(rows[0]!);
}

/** Помечает письмо отправленным (проставляет sent_at). */
export async function markMailSent(id: string, attempts: number): Promise<MailLogEntry | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE mail_log
       SET status = 'sent',
           attempts = ${attempts},
           error = NULL,
           sent_at = now(),
           updated_at = now()
     WHERE id = ${id}
    RETURNING ${cols()}
  `;
  return rows[0] ? mapMailLog(rows[0]) : null;
}

/** Помечает письмо неотправленным (кандидат на досылку). */
export async function markMailFailed(
  id: string,
  attempts: number,
  error: string,
): Promise<MailLogEntry | null> {
  const rows = await sql<Record<string, unknown>[]>`
    UPDATE mail_log
       SET status = 'failed',
           attempts = ${attempts},
           error = ${error},
           updated_at = now()
     WHERE id = ${id}
    RETURNING ${cols()}
  `;
  return rows[0] ? mapMailLog(rows[0]) : null;
}

// =============================================================================
// Чтение.
// =============================================================================

/** Одна запись журнала по id (карточка/повторная отправка). */
export async function getMailLogById(id: string): Promise<MailLogEntry | null> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${cols()} FROM mail_log WHERE id = ${id} LIMIT 1
  `;
  return rows[0] ? mapMailLog(rows[0]) : null;
}

/** Список для раздела «Письма» админки: от новых к старым. */
export async function listMailLog(limit = 200): Promise<MailLogEntry[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${cols()} FROM mail_log
    ORDER BY created_at DESC, id
    LIMIT ${limit}
  `;
  return rows.map(mapMailLog);
}

/** Общее число записей (счётчик и плашка усечения списка). */
export async function countMailLog(): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM mail_log`;
  return Number(rows[0]?.count ?? 0);
}

/** Письма конкретного заказа (карточка заказа / разбор спора). */
export async function listMailLogForOrder(orderId: string): Promise<MailLogEntry[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${cols()} FROM mail_log
    WHERE order_id = ${orderId}
    ORDER BY created_at DESC, id
  `;
  return rows.map(mapMailLog);
}

/**
 * Кандидаты на досылку кроном: только status='failed'.
 *
 * 'skipped' СЮДА НЕ ПОПАДАЕТ ОСОЗНАННО. Это письма, которые не отправлялись по
 * неустранимой на стороне крона причине (почта магазина не настроена, у заказа
 * нет адреса). Ретраить их значило бы каждые несколько минут писать в лог одну и
 * ту же ошибку по всей истории магазина. Когда владелец настроит SMTP, такие
 * письма пересылаются кнопкой из админки — осознанным действием.
 *
 * `attempts` в отбор не входит: досылка — это НОВАЯ попытка спустя время, а не
 * продолжение прежней серии (иначе после трёх внутренних попыток письмо с кодом
 * сертификата не досылалось бы уже никогда).
 */
export async function findRetryableMail(limit = 100): Promise<MailLogEntry[]> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${cols()} FROM mail_log
    WHERE status = 'failed'
    ORDER BY created_at
    LIMIT ${limit}
  `;
  return rows.map(mapMailLog);
}

/**
 * Снимает запись с очереди досылки ПОСЛЕ того, как по ней сделана новая попытка.
 *
 * 🔴 ЗАЧЕМ ЭТО СУЩЕСТВУЕТ. Досылка не правит старую строку — она пересобирает
 * письмо и заводит НОВУЮ запись журнала (тела в старой нет по построению).
 * Старая осталась бы в статусе 'failed', то есть кандидатом НАВСЕГДА: каждые 20
 * минут крон брал бы её снова, и покупатель получал бы одно и то же письмо — в
 * том числе с кодом подарочного сертификата — десятки раз.
 *
 * ПОЧЕМУ 'skipped', А НЕ 'sent'. Записать 'sent' значило бы соврать: это письмо
 * так и не ушло, ушло ДРУГОЕ (новое, со своей строкой). 'skipped' в этой
 * платформе означает ровно «отправки по этой записи не было и не будет», что и
 * произошло. Текст в error объясняет оператору, куда смотреть дальше.
 *
 * Гонок нет: весь прогон крона идёт под advisory-lock, а `WHERE status='failed'`
 * делает вызов идемпотентным (повторный UPDATE не тронет ни одной строки).
 */
export async function markMailRetried(id: string): Promise<void> {
  await sql`
    UPDATE mail_log
       SET status = 'skipped',
           error = 'superseded_by_resend',
           updated_at = now()
     WHERE id = ${id}
       AND status = 'failed'
  `;
}

/** Прод-реализация порта журнала для отправителя. */
export function createMailJournal(): MailJournal {
  return {
    create: insertMailLog,
    markSent: markMailSent,
    markFailed: markMailFailed,
  };
}
