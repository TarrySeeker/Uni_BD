/**
 * Журнал согласий (152-ФЗ). Append-only: по ч.1 ст.9 наличие согласия доказывает
 * ОПЕРАТОР, поэтому запись не изменяется и не удаляется (в GRANT миграции 0035
 * нет UPDATE/DELETE — БД не даст этого сделать даже по ошибке).
 *
 * Параметризованный sql (postgres.js), без бизнес-логики — как lib/leads/repository.
 */
import { sql } from '@/lib/db/client';
import { logger } from '@/lib/logger';

import { CONSENT_TEXTS, CONSENT_VERSION, type ConsentPurpose } from './schemas';

export interface ConsentLogRow {
  id: string;
  purpose: string;
  source: string;
  source_ref: string | null;
  subject: string;
  consent_text: string;
  consent_version: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
}

export interface RecordConsentInput {
  /** Виды согласий, которые субъект реально дал (см. consentEntries). */
  purposes: readonly ConsentPurpose[];
  /** Где дано: 'order' | 'lead' | 'newsletter'. */
  source: string;
  /** Номер заказа / id заявки — если объект уже создан. */
  sourceRef?: string | null;
  /** Контакт субъекта (email или телефон) — по нему ищут согласие при отзыве. */
  subject: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Пишет по строке на каждый вид согласия одним INSERT.
 *
 * Текст берётся из CONSENT_TEXTS на сервере, а НЕ из тела запроса: иначе
 * клиент мог бы записать в журнал произвольную формулировку и «подтвердить»
 * согласие на то, чего покупателю не показывали.
 */
export async function recordConsent(input: RecordConsentInput): Promise<void> {
  if (input.purposes.length === 0) return;

  const rows = input.purposes.map((purpose) => ({
    purpose,
    source: input.source,
    source_ref: input.sourceRef ?? null,
    subject: input.subject,
    consent_text: CONSENT_TEXTS[purpose],
    consent_version: CONSENT_VERSION,
    ip: input.ip ?? null,
    user_agent: input.userAgent ?? null,
  }));

  await sql`INSERT INTO consent_log ${sql(
    rows,
    'purpose',
    'source',
    'source_ref',
    'subject',
    'consent_text',
    'consent_version',
    'ip',
    'user_agent',
  )}`;
}

/**
 * Запись согласия, которая НЕ роняет основную операцию.
 *
 * Покупатель согласие дал — отказать ему в заказе из-за недоступности журнала
 * несправедливо. Но и терять факт молча нельзя: сбой уходит в лог с пометкой,
 * по которой его видно в мониторинге.
 */
export async function recordConsentSafe(input: RecordConsentInput): Promise<void> {
  try {
    await recordConsent(input);
  } catch (err) {
    logger.error('consent: не удалось записать согласие в журнал', {
      source: input.source,
      sourceRef: input.sourceRef ?? null,
      purposes: input.purposes.join(','),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Согласия по субъекту (обращение об отзыве/предоставлении сведений). */
export async function listConsentsBySubject(
  subject: string,
  limit = 200,
): Promise<ConsentLogRow[]> {
  return sql<ConsentLogRow[]>`
    SELECT id, purpose, source, source_ref, subject, consent_text, consent_version,
           host(ip) AS ip, user_agent, created_at
    FROM consent_log
    WHERE subject = ${subject}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}

/** Последние записи журнала — для выгрузки при проверке. */
export async function listConsents(limit = 500): Promise<ConsentLogRow[]> {
  return sql<ConsentLogRow[]>`
    SELECT id, purpose, source, source_ref, subject, consent_text, consent_version,
           host(ip) AS ip, user_agent, created_at
    FROM consent_log
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
}
