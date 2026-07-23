import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD (структура исходника, не поведение): ВРЕЗКИ АВТОВЫПУСКА И ГАШЕНИЯ в
 * lib/orders. Тестов React/интеграции с БД в проекте нет, а инварианты здесь
 * денежные, поэтому сторожим их по исходнику.
 *
 * 🔴 Главный инвариант: автовыпуск вызывается ПОСЛЕ КОММИТА транзакции оплаты.
 * Фиксация оплаты (лог вебхука + переход в paid + пометка processed) идёт одной
 * транзакцией; любой throw ВНУТРИ неё откатил бы САМ ФАКТ ОПЛАТЫ, а повторная
 * доставка вебхука была бы отсечена по UNIQUE(payment_id,status) — деньги
 * приняты, заказ pending. Поэтому вызов обязан стоять вне sql.begin и быть
 * обёрнут в try/catch.
 */

const ROOT = join(process.cwd(), 'lib', 'orders');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

const actions = read('actions.ts');
const repository = read('repository.ts');
const refundSettle = read('refund-settle.ts');

/**
 * Диапазоны строк [начало, конец] колбэков `sql.begin(...)` (код отформатирован
 * prettier: закрывающая `});` стоит на том же отступе, что и `await sql.begin(`).
 */
function transactionRanges(src: string): Array<[number, number]> {
  const lines = src.split('\n');
  const ranges: Array<[number, number]> = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:const \w+ = )?await sql\.begin\(/.exec(line);
    if (!m) return;
    const indent = m[1]!;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j] === `${indent}});`) {
        ranges.push([i, j]);
        return;
      }
    }
    throw new Error(`не нашёл конец транзакции, начатой на строке ${i + 1}`);
  });
  return ranges;
}

/** Номера строк (0-based), где встречается подстрока. */
function lineIndexes(src: string, needle: string): number[] {
  return src
    .split('\n')
    .map((l, i) => (l.includes(needle) ? i : -1))
    .filter((i) => i >= 0);
}

function inAnyRange(line: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([a, b]) => line > a && line < b);
}

describe('guard: вызовы автовыпуска стоят ВНЕ транзакции оплаты', () => {
  it('парсер транзакций находит их (страховка самого guard-а)', () => {
    expect(transactionRanges(actions).length).toBeGreaterThan(0);
    expect(transactionRanges(repository).length).toBeGreaterThan(0);
  });

  it('actions.ts: setPaymentStatus дёргает автовыпуск, и ни один вызов не внутри sql.begin', () => {
    const calls = lineIndexes(actions, 'autoIssueGifts');
    expect(calls.length).toBeGreaterThan(0);
    const ranges = transactionRanges(actions);
    for (const line of calls) {
      expect(
        inAnyRange(line, ranges),
        `автовыпуск на строке ${line + 1} попал внутрь транзакции оплаты`,
      ).toBe(false);
    }
  });

  it('repository.ts: путь fullyGiftCovered дёргает автовыпуск вне транзакции создания заказа', () => {
    const calls = lineIndexes(repository, 'autoIssueGifts');
    expect(calls.length).toBeGreaterThan(0);
    const ranges = transactionRanges(repository);
    for (const line of calls) {
      expect(
        inAnyRange(line, ranges),
        `автовыпуск на строке ${line + 1} попал внутрь транзакции создания заказа`,
      ).toBe(false);
    }
  });

  it('ошибка выпуска не ломает основную операцию: вызов внутри try/catch, без rethrow', () => {
    for (const [name, src] of [
      ['actions.ts', actions],
      ['repository.ts', repository],
    ] as const) {
      // Оба файла зовут автовыпуск через общий хелпер-обёртку с проглатыванием
      // ошибки. Проверяем ИМЕННО обёртку: try + catch и никакого throw в ней.
      const m = /async function autoIssueGiftsAfterCommit\([\s\S]*?\n}\n/.exec(src);
      expect(m, `${name}: нет обёртки autoIssueGiftsAfterCommit`).not.toBeNull();
      const body = m![0];
      expect(body).toContain('try {');
      expect(body).toContain('catch');
      expect(body).not.toContain('throw');
    }
  });
});

describe('guard: маркер сертификата дописывается при сборке снимка позиции', () => {
  it('resolveCartLine строит attributesSnapshot через applyGiftCategoryMarker', () => {
    expect(repository).toContain('applyGiftCategoryMarker(');
    // Антипаттерн: сырой снимок каталога без маркера (как было до §5.3) —
    // именно из-за него автовыпуск не срабатывал бы ни разу.
    expect(repository).not.toContain(
      'attributesSnapshot: variant?.attributesCache ?? product.attributesCache ?? {}',
    );
  });

  it('мультитенантность: ни один адрес раздела не захардкожен в lib/orders', () => {
    for (const [name, src] of [
      ['actions.ts', actions],
      ['repository.ts', repository],
      ['refund-settle.ts', refundSettle],
    ] as const) {
      expect(src.includes("'certificates'"), `${name}: хардкод раздела`).toBe(false);
    }
  });
});

describe('guard: гашение выпущенных кодов на ОБОИХ путях возврата', () => {
  it('refund-settle.ts (вебхук/оплата) гасит рядом с возвратом баланса', () => {
    expect(refundSettle).toContain('revokeIssuedGiftsTx(');
    expect(refundSettle).toContain('releaseGiftTx(');
  });

  it('actions.ts (кнопка админа: отмена/возврат) гасит внутри той же транзакции', () => {
    const revokes = lineIndexes(actions, 'revokeIssuedGiftsTx(');
    // Импорт + минимум один вызов; вызов обязан быть ВНУТРИ транзакции перехода
    // (гашение обязано откатиться вместе с неудавшимся возвратом).
    const ranges = transactionRanges(actions);
    expect(revokes.some((line) => inAnyRange(line, ranges))).toBe(true);
  });
});
