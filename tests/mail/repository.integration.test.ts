import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyAllMigrations } from '@/tests/helpers/apply-migrations';

/**
 * Интеграционные тесты журнала писем (таблица mail_log, миграция 0061).
 *
 * Проверяем то, что нельзя проверить юнитом: реальный DDL и его инварианты —
 * CHECK статусов, дефолты, регистронезависимость адресата (citext), поведение FK
 * при удалении заказа и выборку кандидатов на досылку.
 *
 * Запускается ТОЛЬКО с БД (describe.skipIf), как остальной интеграционный тир.
 */

const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('mail_log (интеграция, нужна БД)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    await applyAllMigrations();
    sql = postgres(INTEGRATION_DB_URL!, { onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** Уникальный адрес на прогон — тесты не должны видеть строки друг друга. */
  const uniq = () => `mail-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;

  it('миграция 0061 отмечена в schema_migrations', async () => {
    const rows = await sql`SELECT version FROM schema_migrations WHERE version = '0061'`;
    expect(rows).toHaveLength(1);
  });

  it('строка заводится с дефолтами: status=pending, attempts=0', async () => {
    const to = uniq();
    const rows = await sql<Record<string, unknown>[]>`
      INSERT INTO mail_log (recipient, template) VALUES (${to}, 'order_confirmation')
      RETURNING status, attempts, created_at, updated_at, sent_at
    `;
    expect(rows[0]!.status).toBe('pending');
    expect(Number(rows[0]!.attempts)).toBe(0);
    expect(rows[0]!.created_at).toBeTruthy();
    expect(rows[0]!.sent_at).toBeNull();
  });

  it('CHECK отвергает статус вне набора pending|sent|failed|skipped', async () => {
    await expect(
      sql`INSERT INTO mail_log (recipient, template, status)
          VALUES (${uniq()}, 'order_confirmation', 'выдумка')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it.each(['pending', 'sent', 'failed', 'skipped'])('статус %s допустим', async (status) => {
    const rows = await sql<Record<string, unknown>[]>`
      INSERT INTO mail_log (recipient, template, status)
      VALUES (${uniq()}, 'gift_certificate', ${status})
      RETURNING status
    `;
    expect(rows[0]!.status).toBe(status);
  });

  it('адресат регистронезависим (citext) — поиск «что слали на адрес» работает', async () => {
    const to = uniq();
    await sql`INSERT INTO mail_log (recipient, template) VALUES (${to}, 'order_confirmation')`;
    const rows = await sql`SELECT id FROM mail_log WHERE recipient = ${to.toUpperCase()}`;
    expect(rows.length).toBeGreaterThan(0);
  });

  it('🔴 в таблице НЕТ колонок под тело письма и код сертификата', async () => {
    const rows = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_log'
    `;
    const names = rows.map((r) => r.column_name);
    for (const forbidden of ['html', 'text', 'body', 'code', 'payload']) {
      expect(names, `в mail_log появилась колонка ${forbidden} — там нельзя хранить тело письма`)
        .not.toContain(forbidden);
    }
  });

  it('досылка видит только failed (skipped не ретраится вечно)', async () => {
    const failedTo = uniq();
    const skippedTo = uniq();
    await sql`INSERT INTO mail_log (recipient, template, status)
              VALUES (${failedTo}, 'gift_certificate', 'failed')`;
    await sql`INSERT INTO mail_log (recipient, template, status)
              VALUES (${skippedTo}, 'gift_certificate', 'skipped')`;

    const rows = await sql<{ recipient: string }[]>`
      SELECT recipient FROM mail_log WHERE status = 'failed' AND recipient IN (${failedTo}, ${skippedTo})
    `;
    const recipients = rows.map((r) => r.recipient);
    expect(recipients).toContain(failedTo);
    expect(recipients).not.toContain(skippedTo);
  });

  it('частичный индекс досылки существует (иначе выборка растёт по всей истории)', async () => {
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'mail_log'
    `;
    const names = rows.map((r) => r.indexname);
    expect(names).toContain('mail_log_retryable_idx');
    expect(names).toContain('mail_log_created_at_idx');
  });

  it('order_id — SET NULL при удалении заказа: журнал переживает удаление', async () => {
    const rows = await sql<{ confdeltype: string }[]>`
      SELECT c.confdeltype
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
       WHERE t.relname = 'mail_log' AND c.contype = 'f'
    `;
    expect(rows.length).toBeGreaterThan(0);
    // 'n' = SET NULL. CASCADE ('c') стёр бы доказательство отправки кода.
    expect(rows.every((r) => r.confdeltype === 'n')).toBe(true);
  });

  /**
   * 🔴 Без снятия с очереди крон слал бы покупателю одно и то же письмо (в т.ч.
   * с кодом сертификата) каждые 20 минут вечно — см. markMailRetried.
   */
  it('markMailRetried снимает failed-запись с очереди досылки', async () => {
    const { markMailRetried, findRetryableMail } = await import('@/lib/mail/repository');
    const to = uniq();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO mail_log (recipient, template, status)
      VALUES (${to}, 'gift_certificate', 'failed')
      RETURNING id
    `;
    const id = rows[0]!.id;

    await markMailRetried(id);

    const after = await sql<{ status: string; error: string }[]>`
      SELECT status, error FROM mail_log WHERE id = ${id}
    `;
    expect(after[0]!.status).toBe('skipped');
    expect(after[0]!.error).toBe('superseded_by_resend');

    // И главное: запись больше не кандидат на досылку.
    const candidates = await findRetryableMail(500);
    expect(candidates.map((c) => c.id)).not.toContain(id);
  });

  it('markMailRetried идемпотентен и не трогает уже отправленные письма', async () => {
    const { markMailRetried } = await import('@/lib/mail/repository');
    const to = uniq();
    const rows = await sql<{ id: string }[]>`
      INSERT INTO mail_log (recipient, template, status)
      VALUES (${to}, 'order_confirmation', 'sent')
      RETURNING id
    `;
    const id = rows[0]!.id;

    // Повторный вызов по 'sent'-записи не должен переписывать её статус.
    await markMailRetried(id);
    await markMailRetried(id);

    const after = await sql<{ status: string }[]>`SELECT status FROM mail_log WHERE id = ${id}`;
    expect(after[0]!.status).toBe('sent');
  });

  it('накат миграции идемпотентен (повторный прогон не падает)', async () => {
    await expect(applyAllMigrations()).resolves.not.toThrow();
  });
});
