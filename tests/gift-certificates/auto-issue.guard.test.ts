import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD автопути выпуска сертификатов.
 *
 * Сторожим ПРИЧИНУ двух классов дефектов, которые юнит поймать не может:
 *  1) детерминированный код (buildGiftCodeForOrderItem) в автопути — публичный
 *     оракул POST /api/storefront/v1/cart/quote отвечает applied/not_found, значит
 *     код на ~24 бита перебирается; автовыпуск обязан звать randomGiftCode;
 *  2) код сертификата в аргументах логгера — логи уезжают в docker json-file и
 *     читаются кем угодно с доступом к серверу; код — это деньги на предъявителя.
 */

const ROOT = resolve(__dirname, '../..');
const AUTO_ISSUE = resolve(ROOT, 'lib/gift-certificates/auto-issue.ts');
const src = readFileSync(AUTO_ISSUE, 'utf8');

/** Код без комментариев — сторожим исполняемый текст, а не документацию. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Аргументы всех вызовов logger.*(...) (грубый разбор со счётчиком скобок). */
function loggerCallArgs(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:logger|log)\s*\.\s*(?:debug|info|warn|error)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    out.push(text.slice(start, i - 1));
  }
  return out;
}

describe('guard: автовыпуск сертификатов', () => {
  const code = stripComments(src);

  it('механизм есть: автопуть генерирует код через randomGiftCode', () => {
    expect(code).toMatch(/randomGiftCode/);
  });

  it('антипаттерн запрещён: детерминированный buildGiftCodeForOrderItem в автопути отсутствует', () => {
    expect(code).not.toMatch(/buildGiftCodeForOrderItem/);
  });

  it('в файле есть логирование (иначе следующая проверка тавтологична)', () => {
    expect(loggerCallArgs(code).length).toBeGreaterThan(0);
  });

  it('код сертификата не передаётся в логгер ни под каким именем', () => {
    for (const args of loggerCallArgs(code)) {
      expect(args).not.toMatch(/code/i);
    }
  });

  it('не пробрасывает throw наружу: тело обёрнуто в try/catch', () => {
    expect(code).toMatch(/try\s*\{/);
    expect(code).toMatch(/catch\s*\(/);
  });

  it('автопуть не является Server Action (у вебхука нет RBAC-контекста)', () => {
    expect(code).not.toMatch(/defineAction|['"]use server['"]/);
  });
});
