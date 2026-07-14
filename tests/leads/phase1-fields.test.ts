import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  LeadInputSchema,
  LeadAnswerInputSchema,
  leadSourceLabel,
} from '@/lib/leads/schemas';

/**
 * §9: доп. поля заявок (leads.company/city/subject/answer/attachment_key) +
 * значение source='callback'. Аддитивно/обратно совместимо.
 *
 * (а) ЮНИТ — схемы (опц. поля витрины, ответ оператора), метка источника.
 * (б) ИНТЕГРАЦИЯ (skipIf без БД) — round-trip insert/getLead/updateLeadAnswer,
 *     обратная совместимость (заявка без доп.полей), source='callback'.
 */

// =============================================================================
// (а) ЮНИТ.
// =============================================================================
describe('§9 leads — схемы (юнит)', () => {
  it('LeadInputSchema: доп. поля опциональны — старая форма без них валидна', () => {
    const parsed = LeadInputSchema.safeParse({ name: 'A', contact: 'a@b.c', message: 'hi' });
    expect(parsed.success).toBe(true);
  });

  it('LeadInputSchema: принимает company/city/subject', () => {
    const parsed = LeadInputSchema.safeParse({
      name: 'A', contact: 'a@b.c', message: 'hi',
      company: 'ООО Ромашка', city: 'Москва', subject: 'Опт',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.company).toBe('ООО Ромашка');
      expect(parsed.data.city).toBe('Москва');
      expect(parsed.data.subject).toBe('Опт');
    }
  });

  it('LeadAnswerInputSchema: id (uuid) + текст; пустой ответ допустим (снятие)', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(LeadAnswerInputSchema.safeParse({ id, answer: 'Ответ' }).success).toBe(true);
    expect(LeadAnswerInputSchema.safeParse({ id, answer: '' }).success).toBe(true);
    expect(LeadAnswerInputSchema.safeParse({ id: 'not-uuid', answer: 'x' }).success).toBe(false);
  });

  it('leadSourceLabel: callback имеет человекочитаемую метку', () => {
    expect(leadSourceLabel('callback')).toBe('Обратный звонок');
    expect(leadSourceLabel('contact_form')).toBe('Форма контактов');
    // Неизвестный источник — passthrough (не падаем).
    expect(leadSourceLabel('telegram')).toBe('telegram');
  });
});

// =============================================================================
// (б) ИНТЕГРАЦИЯ — реальная БД.
// =============================================================================
const INTEGRATION_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

describe.skipIf(!INTEGRATION_DB_URL)('§9 leads (интеграция, нужна БД)', () => {
  let sql: typeof import('@/lib/db/client').sql;
  let closeSql: typeof import('@/lib/db/client').closeSql;
  let repo: typeof import('@/lib/leads/repository');
  const ids: string[] = [];

  beforeAll(async () => {
    const db = await import('@/lib/db/client');
    sql = db.sql;
    closeSql = db.closeSql;
    repo = await import('@/lib/leads/repository');
  });

  afterAll(async () => {
    for (const id of ids) await sql`DELETE FROM leads WHERE id = ${id}`;
    if (closeSql) await closeSql();
  });

  it('insertLead с доп.полями → getLead round-trip', async () => {
    const { id } = await repo.insertLead({
      name: 'Клиент', contact: 'c@x.y', message: 'заявка',
      company: 'ООО Тест', city: 'СПб', subject: 'Сотрудничество',
      attachmentKey: 'leads/file.pdf',
    });
    ids.push(id);
    const lead = await repo.getLead(id);
    expect(lead?.company).toBe('ООО Тест');
    expect(lead?.city).toBe('СПб');
    expect(lead?.subject).toBe('Сотрудничество');
    expect(lead?.attachment_key).toBe('leads/file.pdf');
    expect(lead?.answer).toBeNull();
  });

  it('обратная совместимость: простая заявка → доп.поля NULL', async () => {
    const { id } = await repo.insertLead({ name: 'X', contact: 'x@y.z', message: 'm' });
    ids.push(id);
    const lead = await repo.getLead(id);
    expect(lead?.company).toBeNull();
    expect(lead?.city).toBeNull();
    expect(lead?.subject).toBeNull();
    expect(lead?.attachment_key).toBeNull();
  });

  it('updateLeadAnswer: пишет ответ; пустой снимает (NULL)', async () => {
    const { id } = await repo.insertLead({ name: 'X', contact: 'x@y.z', message: 'm' });
    ids.push(id);
    expect(await repo.updateLeadAnswer(id, 'Мы свяжемся')).toBe(true);
    expect((await repo.getLead(id))?.answer).toBe('Мы свяжемся');
    expect(await repo.updateLeadAnswer(id, '   ')).toBe(true);
    expect((await repo.getLead(id))?.answer).toBeNull();
  });

  it("source='callback' сохраняется (CHECK на source нет)", async () => {
    const { id } = await repo.insertLead({
      name: 'Звонок', contact: '+70000000000', message: 'перезвоните', source: 'callback',
    });
    ids.push(id);
    expect((await repo.getLead(id))?.source).toBe('callback');
  });
});
