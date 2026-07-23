import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * СТРУКТУРНЫЕ ГАРДЫ врезки автовыпуска подарочных сертификатов в платежи (ТЗ п.11).
 *
 * Сторожат СУТЬ, а не подстроку:
 *   1) в репозиториях провайдеров (recordWebhookEvent / applyPaymentStatusTx) НЕТ
 *      ни одного упоминания сертификатов — вызов внутри той транзакции откатил бы
 *      САМ ФАКТ ОПЛАТЫ при любом throw, а повторный вебхук был бы отсечён по
 *      UNIQUE(payment_id, status): деньги приняты, заказ pending (АНТИПАТТЕРН);
 *   2) в service.ts автовыпуск вызывается ТОЛЬКО после await recordWebhookEvent
 *      (после КОММИТА) — по индексам в исходнике, каждый вызов позже своей фиксации;
 *   3) вызов обёрнут в try/catch — ошибка выпуска не должна портить ответ
 *      провайдеру (иначе банк начнёт ретраить вебхук);
 *   4) КАЖДАЯ фиксация события (await recordWebhookEvent) сопровождается хуком —
 *      иначе новый путь оплаты (mock-подтверждение, сверка cron) молча остался бы
 *      без сертификата;
 *   5) хук стреляет строго при { inserted: true, applied: true, paymentStatus: 'paid' }.
 */

const ROOT = resolve(__dirname, '../..');
const PROVIDERS = ['tbank', 'paykeeper', 'alfabank'] as const;

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

/** Индексы всех вхождений подстроки. */
function indexesOf(src: string, needle: string): number[] {
  const out: number[] = [];
  let i = src.indexOf(needle);
  while (i !== -1) {
    out.push(i);
    i = src.indexOf(needle, i + 1);
  }
  return out;
}

describe.each(PROVIDERS)('payments/%s — врезка автовыпуска сертификатов', (provider) => {
  const repoSrc = read(`lib/payments/${provider}/repository.ts`);
  const svcSrc = read(`lib/payments/${provider}/service.ts`);

  it('репозиторий НЕ знает о сертификатах (нет вызова внутри транзакции оплаты)', () => {
    expect(repoSrc).not.toMatch(/gift/i);
    expect(repoSrc).not.toMatch(/autoIssue/i);
  });

  it('recordWebhookEvent отдаёт applied + paymentStatus (результат перехода не теряется)', () => {
    expect(repoSrc).toMatch(/applied:\s*boolean/);
    expect(repoSrc).toMatch(/paymentStatus:\s*PaymentStatus\s*\|\s*null/);
  });

  it('service импортирует автовыпуск из lib/gift-certificates/auto-issue', () => {
    expect(svcSrc).toMatch(
      /import\s*\{\s*autoIssueGiftsForPaidOrder\s*\}\s*from\s*'@\/lib\/gift-certificates\/auto-issue'/,
    );
  });

  it('автовыпуск вызывается ровно в одном месте — в пост-коммитном хуке', () => {
    // import + единственный вызов внутри хука. Любой второй вызов (например,
    // затащенный внутрь транзакции) сломает гард.
    expect(indexesOf(svcSrc, 'autoIssueGiftsForPaidOrder')).toHaveLength(2);
  });

  it('хук ловит ошибку выпуска (try/catch) — ответ провайдеру не портится', () => {
    const hook = svcSrc.slice(svcSrc.indexOf('async function autoIssueGiftsAfterCommit'));
    const body = hook.slice(0, hook.indexOf('\n}\n') + 3);
    const tryAt = body.indexOf('try {');
    const callAt = body.indexOf('await autoIssueGiftsForPaidOrder(');
    const catchAt = body.indexOf('} catch');
    expect(tryAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(callAt);
  });

  it('хук стреляет строго при inserted && applied && paymentStatus === paid', () => {
    expect(svcSrc).toMatch(
      /result\.inserted\s*&&\s*result\.applied\s*&&\s*result\.paymentStatus\s*===\s*'paid'/,
    );
  });

  it('хук стоит в КАЖДОМ пути фиксации оплаты и всегда ПОСЛЕ recordWebhookEvent', () => {
    // Пути в paid: боевой колбэк, demo-подтверждение на стенде, сверка cron.
    const entryPoints = [
      provider === 'tbank' ? 'handleWebhook' : 'handleCallback',
      'confirmMockPayment',
      'reconcilePayment',
    ];
    // Границы методов: все они объявлены как `  async name(`.
    const bounds = indexesOf(svcSrc, '\n  async ');
    for (const name of entryPoints) {
      const start = svcSrc.indexOf(`\n  async ${name}(`);
      expect(start, `метод ${name} не найден`).toBeGreaterThan(0);
      const end = bounds.find((i) => i > start) ?? svcSrc.length;
      const body = svcSrc.slice(start, end);
      const record = body.indexOf('await recordWebhookEvent(');
      const hook = body.indexOf('await autoIssueGiftsAfterCommit(');
      expect(record, `${name}: нет фиксации события`).toBeGreaterThanOrEqual(0);
      expect(hook, `${name}: нет пост-коммитного хука автовыпуска`).toBeGreaterThan(record);
    }
  });
});
