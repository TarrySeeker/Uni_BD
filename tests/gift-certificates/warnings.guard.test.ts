import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD-тесты трека T5: предупреждения о возврате должны РЕАЛЬНО доезжать до
 * менеджера в обоих слотах карточки заказа. Тестов React-компонентов в проекте
 * нет (environment 'node'), поэтому сторожим суть по исходнику: нужный механизм
 * присутствует И антипаттерн «функция есть, а в UI не выводится» запрещён.
 */

function src(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

const WARNINGS = src('lib/gift-certificates/warnings.ts');
const ORDER_PAGE = src('app/admin/(panel)/orders/[id]/page.tsx');
const GIFT_BLOCK = src('app/admin/(panel)/orders/[id]/_components/GiftIssueBlock.tsx');
const ACTIONS = src('app/admin/(panel)/orders/_components/OrderActionsPanel.tsx');

// После i18n-переноса подпись «потрачено» живёт в messages/ru.json (блок рендерит t(...)).
// GUARD сторожит суть: исходник ссылается на ключ И ru-значение несёт текст.
const ru = JSON.parse(src('messages/ru.json')) as Record<string, unknown>;
function ruVal(dot: string): string {
  let o: unknown = ru;
  for (const k of dot.split('.')) o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  return typeof o === 'string' ? o : '';
}

describe('ядро предупреждений — чистое и не течёт в клиентский бандл', () => {
  it('warnings.ts не тянет БД/Next-серверные модули', () => {
    expect(WARNINGS).not.toMatch(/from\s+'@\/lib\/db/);
    expect(WARNINGS).not.toMatch(/from\s+'next\/(headers|cache)'/);
    expect(WARNINGS).not.toContain("'server-only'");
    expect(WARNINGS).not.toMatch(/from\s+'\.\/repository'/);
  });

  it('код по умолчанию маскируется — раскрытие только по явному флагу', () => {
    expect(WARNINGS).toContain('maskGiftCode');
    expect(WARNINGS).toContain('revealCode');
  });
});

describe('карточка заказа считает предупреждения на сервере', () => {
  it('вызывает giftRefundWarnings и прокидывает результат в ОБА слота', () => {
    expect(ORDER_PAGE).toContain('giftRefundWarnings(');
    expect(ORDER_PAGE).toMatch(/giftWarnings=\{/);
    expect(ORDER_PAGE).toMatch(/warnings=\{/);
  });

  it('в выпущенные сертификаты прокинуты потраченное и статус (иначе их негде показать)', () => {
    const start = ORDER_PAGE.indexOf('const issuedView');
    expect(start).toBeGreaterThan(-1);
    const view = ORDER_PAGE.slice(start, start + 900);
    expect(view).toContain('c.spentTotal');
    expect(view).toContain('c.status');
    expect(view).toContain('c.currency');
  });

  it('предупреждения считаются из РЕАЛЬНЫХ выпущенных сертификатов, а не из заглушки', () => {
    const input = ORDER_PAGE.slice(ORDER_PAGE.indexOf('const giftWarningInput'));
    expect(input.slice(0, 300)).toContain('issuedCerts.map');
    expect(ORDER_PAGE).not.toMatch(/giftRefundWarnings\(\s*\[\s*\]/);
  });
});

describe('слот 1 — баннер role="status" в панели действий', () => {
  it('панель принимает предупреждения и рендерит их в баннер', () => {
    expect(ACTIONS).toMatch(/giftWarnings\??:\s*readonly string\[\]/);
    expect(ACTIONS).toContain('giftWarnings.length > 0');
    expect(ACTIONS).toMatch(/giftWarnings\.map\(/);
  });

  it('баннер именно role="status" и стоит рядом с кнопкой возврата', () => {
    const banner = ACTIONS.slice(
      ACTIONS.indexOf('giftWarnings.length > 0'),
      ACTIONS.indexOf('giftWarnings.length > 0') + 600,
    );
    expect(banner).toContain('role="status"');
    expect(ACTIONS).toContain('refundOrderAction');
  });
});

describe('слот 2 — блок сертификата, role="alert"', () => {
  it('блок принимает предупреждения и выводит их в role="alert"', () => {
    expect(GIFT_BLOCK).toMatch(/warnings\??:\s*readonly string\[\]/);
    expect(GIFT_BLOCK).toContain('warnings.length > 0');
    expect(GIFT_BLOCK).toMatch(/warnings\.map\(/);
    const block = GIFT_BLOCK.slice(
      GIFT_BLOCK.indexOf('warnings.length > 0'),
      GIFT_BLOCK.indexOf('warnings.length > 0') + 600,
    );
    expect(block).toContain('role="alert"');
  });

  it('в списке выпущенных видно потраченное и статус кода', () => {
    expect(GIFT_BLOCK).toContain('c.spentLabel');
    expect(GIFT_BLOCK).toContain('status={c.status}');
    expect(GIFT_BLOCK).toContain('orders.detailGiftIssueBlock.spentLine');
    expect(ruVal('orders.detailGiftIssueBlock.spentLine')).toContain('потрачено');
  });
});
