import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD границы «клиент → сервер»: ни один клиентский модуль не должен прямо
 * или транзитивно импортировать драйвер БД.
 *
 * WHY: production-сборка (Turbopack) падала уже трижды с «Module not found:
 * Can't resolve 'fs' / 'net' / 'tls' / 'perf_hooks'» — клиентская форма через
 * общий модуль дотягивалась до lib/db/client → postgres → node-only модули в
 * браузерном бандле. Ни typecheck, ни vitest, ни next dev такое не ловят: это
 * видно ТОЛЬКО в прод-сборке (~минуты). Тест воспроизводит ту же трассировку
 * импортов статически — за секунды.
 *
 * Сторожим ПРИЧИНУ, а не известные плохие пары: обходим граф импортов от всех
 * клиентских корней и падаем на любом пути до запрещённого модуля, включая
 * случаи, которых сегодня ещё нет.
 */

const ROOT = resolve(__dirname, '../..');

/** Модули, которых не должно быть в браузерном бандле (тянут node-only API). */
const FORBIDDEN = ['lib/db/client.ts'];

/** Где ищем клиентские корни. */
const SCAN_DIRS = ['app', 'lib', 'components'];

const SOURCE_RE = /\.(ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'storefront', 'coverage']);

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (SOURCE_RE.test(name) && !name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const sourceCache = new Map<string, string>();
function read(file: string): string {
  let src = sourceCache.get(file);
  if (src === undefined) {
    src = readFileSync(file, 'utf8');
    sourceCache.set(file, src);
  }
  return src;
}

/** Директива в начале файла ('use client' / 'use server'), с учётом комментариев. */
function hasDirective(src: string, directive: string): boolean {
  const head = src.slice(0, 4000);
  return new RegExp(`(^|\\n)\\s*['"]${directive}['"]\\s*;?`).test(head.split(/\n(?=import |export )/)[0]);
}

/**
 * Спецификаторы, которые реально попадают в бандл: статические import/export-from,
 * динамический import() и require(). Чисто типовые импорты (`import type ...`)
 * стираются компилятором и в бандл не идут — их пропускаем.
 */
function extractSpecifiers(src: string): string[] {
  const specs: string[] = [];

  const staticRe = /(^|\n)\s*(import|export)(\s+type)?\b([^;'"]*?)from\s*['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(staticRe)) {
    const typeKeyword = m[3];
    if (typeKeyword) continue; // import type { X } from '...' — стирается
    specs.push(m[5]);
  }

  // `import 'x'` (side-effect only)
  for (const m of src.matchAll(/(^|\n)\s*import\s*['"]([^'"]+)['"]/g)) specs.push(m[2]);

  // Динамический import('x') и require('x') — Turbopack трассирует их тоже.
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);

  return specs;
}

const CANDIDATE_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Резолвит спецификатор проекта в файл; внешние пакеты → null. */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
  else return null; // bare specifier — node_modules, не наш граф

  const bases = base.endsWith('.js') ? [base.slice(0, -3), base] : [base];
  for (const b of bases) {
    for (const suffix of CANDIDATE_SUFFIXES) {
      const candidate = b + suffix;
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* пробуем следующий вариант */
      }
    }
  }
  return null;
}

const allSources = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));

/**
 * Клиентские корни: файлы с директивой 'use client' и чистые модули состояния
 * форм (*-form-state.ts / *-state.ts) — их импортируют только клиентские формы.
 */
const clientRoots = allSources.filter((f) => {
  if (/-(form-)?state\.ts$/.test(f) && f.startsWith(join(ROOT, 'app'))) return true;
  return hasDirective(read(f), 'use client');
});

const rel = (f: string) => relative(ROOT, f);

/**
 * Ищет путь импортов от клиентского корня до запрещённого модуля.
 * Обход останавливается на модулях с 'use server': Next заменяет их в клиентском
 * бандле на RPC-заглушку, их зависимости в браузер не попадают.
 */
function findForbiddenPath(root: string): string[] | null {
  const queue: Array<{ file: string; path: string[] }> = [{ file: root, path: [rel(root)] }];
  const seen = new Set<string>([root]);

  while (queue.length > 0) {
    const { file, path } = queue.shift()!;
    const src = read(file);

    for (const spec of extractSpecifiers(src)) {
      const target = resolveSpecifier(file, spec);
      if (target === null || seen.has(target)) continue;
      seen.add(target);

      const nextPath = [...path, rel(target)];
      if (FORBIDDEN.some((bad) => rel(target) === bad)) return nextPath;

      // Серверная граница: дальше зависимости в клиент не утекают.
      if (hasDirective(read(target), 'use server')) continue;

      queue.push({ file: target, path: nextPath });
    }
  }
  return null;
}

describe('граница клиент↔сервер: драйвер БД не попадает в браузерный бандл', () => {
  it('клиентские корни вообще найдены (иначе тест бесполезен)', () => {
    expect(clientRoots.length).toBeGreaterThan(20);
  });

  it('запрещённые модули существуют (иначе сторожим пустоту)', () => {
    for (const bad of FORBIDDEN) {
      expect(statSync(join(ROOT, bad)).isFile()).toBe(true);
    }
  });

  it('ни один клиентский модуль не тянет lib/db/client (прямо или транзитивно)', () => {
    const offenders: string[] = [];
    for (const root of clientRoots) {
      const path = findForbiddenPath(root);
      if (path) offenders.push(path.join('\n    → '));
    }

    expect(
      offenders,
      `Клиентский модуль дотягивается до драйвера БД — прод-сборка упадёт с ` +
        `«Module not found: Can't resolve 'fs'/'net'/'tls'». Вынесите чистую часть ` +
        `в leaf-модуль без импорта БД:\n\n  ${offenders.join('\n\n  ')}\n`,
    ).toEqual([]);
  });
});

describe('граница клиент↔сервер: сам механизм обхода жив', () => {
  it('обход находит путь, если клиентский корень действительно тянет БД', () => {
    // Синтетическая проверка «тест умеет падать»: серверный репозиторий настроек
    // заведомо ведёт к lib/db/client — обход обязан этот путь увидеть.
    const path = findForbiddenPath(join(ROOT, 'lib/settings/repository.ts'));
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toBe('lib/db/client.ts');
  });

  it("обход останавливается на модулях с 'use server'", () => {
    const serverAction = join(ROOT, 'app/admin/(panel)/settings/_components/form-actions.ts');
    expect(hasDirective(read(serverAction), 'use server')).toBe(true);
  });
});
