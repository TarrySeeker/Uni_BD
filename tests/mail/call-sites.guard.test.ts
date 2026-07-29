import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * СТРУКТУРНЫЕ ГАРДЫ врезки почты в денежные пути.
 *
 * Сторожат СУТЬ, а не подстроку — по образцу tests/payments/gift-auto-issue.guard:
 *   1) письмо уходит ПОСЛЕ коммита оплаты и ПОСЛЕ автовыпуска сертификатов —
 *      иначе в письме нечего слать (кода ещё нет в БД);
 *   2) вызов обёрнут в try/catch: сбой почты не смеет испортить ответ эквайеру,
 *      иначе банк начнёт ретраить уже обработанный вебхук;
 *   3) репозитории провайдеров о почте НЕ знают: вызов внутри транзакции
 *      фиксации оплаты откатил бы САМ ФАКТ ОПЛАТЫ при любом throw;
 *   4) вебхук СДЭК зовёт письмо о статусе — иначе карта STATUS_TO_CLIENT_TEMPLATE
 *      осталась бы тем же мёртвым кодом, каким была до этой волны.
 */

const ROOT = resolve(__dirname, '../..');
const PROVIDERS = ['tbank', 'paykeeper', 'alfabank'] as const;

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe.each(PROVIDERS)('payments/%s — врезка почты', (provider) => {
  const repoSrc = read(`lib/payments/${provider}/repository.ts`);
  const svcSrc = read(`lib/payments/${provider}/service.ts`);

  it('репозиторий НЕ знает о почте (нет отправки внутри транзакции оплаты)', () => {
    expect(repoSrc).not.toMatch(/notifyOrderPaid/);
    expect(repoSrc).not.toMatch(/@\/lib\/mail/);
  });

  it('service импортирует уведомление из lib/mail/notifications', () => {
    expect(svcSrc).toMatch(
      /import\s*\{\s*notifyOrderPaid\s*\}\s*from\s*'@\/lib\/mail\/notifications'/,
    );
  });

  it('письмо отправляется ПОСЛЕ автовыпуска сертификатов (иначе кода ещё нет)', () => {
    const hookAt = svcSrc.indexOf('async function autoIssueGiftsAfterCommit');
    expect(hookAt).toBeGreaterThanOrEqual(0);
    const body = svcSrc.slice(hookAt);
    const issueAt = body.indexOf('await autoIssueGiftsForPaidOrder(');
    const mailAt = body.indexOf('await notifyOrderPaid(');
    expect(issueAt).toBeGreaterThanOrEqual(0);
    expect(mailAt, 'нет отправки письма после оплаты').toBeGreaterThan(issueAt);
  });

  it('сбой почты пойман try/catch — ответ эквайеру не портится', () => {
    const hookAt = svcSrc.indexOf('async function autoIssueGiftsAfterCommit');
    const body = svcSrc.slice(hookAt);
    const mailAt = body.indexOf('await notifyOrderPaid(');
    const tryBefore = body.lastIndexOf('try {', mailAt);
    const catchAfter = body.indexOf('} catch', mailAt);
    expect(tryBefore).toBeGreaterThanOrEqual(0);
    expect(catchAfter).toBeGreaterThan(mailAt);
  });

  it('почта вызывается ровно в одном месте (не затащена в транзакцию)', () => {
    expect(svcSrc.match(/notifyOrderPaid/g) ?? []).toHaveLength(2); // import + вызов
  });
});

describe('cdek/webhook — письмо о смене статуса доставки', () => {
  const src = read('lib/cdek/services/webhook.ts');

  it('вебхук импортирует уведомление о статусе', () => {
    expect(src).toMatch(
      /import\s*\{\s*notifyDeliveryStatus\s*\}\s*from\s*'@\/lib\/mail\/notifications'/,
    );
  });

  it('письмо шлётся ПОСЛЕ применения перехода статуса (advanceDeliveryStatus)', () => {
    const advanceAt = src.indexOf('await advanceDeliveryStatus(');
    const mailAt = src.indexOf('notifyDeliveryStatus(');
    // Первое вхождение — import; берём вызов после него.
    const callAt = src.indexOf('await notifyDeliveryStatus(');
    expect(advanceAt).toBeGreaterThanOrEqual(0);
    expect(mailAt).toBeGreaterThanOrEqual(0);
    expect(callAt, 'нет вызова письма о статусе').toBeGreaterThan(advanceAt);
  });

  it('сбой почты не мешает вебхуку ответить 200 (try/catch вокруг вызова)', () => {
    const callAt = src.indexOf('await notifyDeliveryStatus(');
    const tryBefore = src.lastIndexOf('try {', callAt);
    const catchAfter = src.indexOf('} catch', callAt);
    expect(tryBefore).toBeGreaterThanOrEqual(0);
    expect(catchAfter).toBeGreaterThan(callAt);
  });

  it('письмо шлётся ДО пометки лога обработанным (иначе ретрай его не догонит)', () => {
    const callAt = src.indexOf('await notifyDeliveryStatus(');
    const markAt = src.indexOf('await markStatusLogProcessed(');
    expect(markAt).toBeGreaterThan(callAt);
  });
});

describe('🔴 БЕЗОПАСНОСТЬ: код сертификата не утекает в логи', () => {
  it('lib/mail не содержит ни одного console.* (логи — только через logger)', () => {
    for (const file of [
      'lib/mail/sender.ts',
      'lib/mail/notifications.ts',
      'lib/mail/templates.ts',
      'lib/mail/repository.ts',
      'lib/mail/order-snapshot.ts',
      'lib/mail/cron.ts',
      'lib/mail/resend.ts',
      'lib/mail/config.ts',
      'lib/mail/transport.ts',
      'lib/mail/types.ts',
    ]) {
      expect(read(file), `${file}: console.* в почтовом модуле`).not.toMatch(/console\./);
    }
  });

  it('журнал не хранит тело письма: в repository нет колонок html/text/body', () => {
    const src = read('lib/mail/repository.ts');
    expect(src).not.toMatch(/\bhtml\b/);
    expect(src).not.toMatch(/\bbody\b/);
  });

  it('миграция журнала не заводит колонок под тело письма и код', () => {
    const sql = read('db/migrations/0061_mail_log.sql');
    const ddl = sql.slice(sql.indexOf('CREATE TABLE'), sql.indexOf('COMMENT ON TABLE'));
    expect(ddl).not.toMatch(/\bhtml\b/i);
    expect(ddl).not.toMatch(/\bbody\b/i);
    expect(ddl).not.toMatch(/\bcode\b/i);
  });
});
