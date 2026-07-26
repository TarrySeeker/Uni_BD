import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard: расписание cron-контейнера (`docker-compose.yml`) и набор задач, объявленных
 * в cron-роутах (`app/api/cron/<группа>/[task]/route.ts`), должны совпадать РОВНО.
 *
 * Зачем: код воркера может быть написан, покрыт тестами и подключён к роуту — и всё
 * равно НИКОГДА не выполняться, если строку не добавили в crontab. Именно так на
 * стенде молча не работали догоняющий автовыпуск сертификатов и сверки платежей
 * PayKeeper/Альфа-Банка: логика есть, планировщик её не дёргает. Обратное расхождение
 * не менее опасно: строка в crontab на несуществующую задачу вечно получает 404, и
 * `curl -fsS` шумит ошибкой, которую никто не читает.
 *
 * Проверяем по ИСХОДНИКАМ (readFileSync обоих файлов) — конфиг docker-compose иначе
 * в этом репозитории не проверить (эталон подхода: tests/storefront-ui/*.guard.test.ts,
 * tests/exchange/cron-route.test.ts).
 *
 * Мультитенантность: список задач НЕ захардкожен — он выводится из файлов, поэтому
 * guard продолжает работать после появления новой группы/задачи в любом инстансе.
 */

const ROOT = process.cwd();
const CRON_API_DIR = join(ROOT, 'app/api/cron');
const COMPOSE = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');

/** Задачи, объявленные в `const TASKS = [...]` каждого cron-роута, как эндпоинты. */
function declaredEndpoints(dir: string = CRON_API_DIR): string[] {
  const groups = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const out: string[] = [];
  for (const group of groups) {
    const route = join(dir, group, '[task]', 'route.ts');
    // ПОЧЕМУ падаем, а не пропускаем: guard существует ровно для того, чтобы воркер
    // не остался без расписания. «Молча пропустить» непонятную группу — заново создать
    // ту же слепую зону, из-за которой на стенде не работали сверки эквайеров. Новая
    // раскладка роутов = осознанное решение автора, тогда пусть он научит ей guard.
    if (!existsSync(route)) {
      throw new Error(
        `крон-группа "${group}": не найден динамический роут ${relative(ROOT, route)}. ` +
          'Guard берёт список задач из const TASKS такого роута. Если группа сознательно ' +
          'оформлена иначе — научи guard её раскладке (пропуск = группа без надзора).',
      );
    }
    const src = readFileSync(route, 'utf8');
    const arr = /const TASKS = \[([^\]]+)\]/.exec(src);
    expect(arr, `в роуте группы ${group} не найден const TASKS = [...]`).toBeTruthy();
    const tasks = [...arr![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(tasks.length, `группа ${group}: пустой TASKS`).toBeGreaterThan(0);
    for (const task of tasks) out.push(`/api/cron/${group}/${task}`);
  }
  return out.sort();
}

/** Строки crontab из docker-compose (echo-строки, дёргающие cron-эндпоинт). */
function crontabLines(): string[] {
  return COMPOSE.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('echo "') && l.includes('/api/cron/'));
}

/** Эндпоинты, реально прописанные в crontab. */
function scheduledEndpoints(): string[] {
  return scheduledEndpointsInOrder().slice().sort();
}

/** Те же эндпоинты, но в порядке строк crontab (для сверки с блоком-документацией). */
function scheduledEndpointsInOrder(): string[] {
  return crontabLines()
    .map((l) => /\/api\/cron\/[a-z0-9-]+\/[a-z0-9-]+/.exec(l)?.[0])
    .filter((v): v is string => Boolean(v));
}

/**
 * Комментарий-документация сервиса cron: строки от заголовка секции до `cron:`.
 * В файле есть и другие блоки «КАК ЭТО РАБОТАЕТ» (backup), поэтому режем по сервису.
 */
function cronDocLines(): string[] {
  const lines = COMPOSE.split('\n');
  const service = lines.findIndex((l) => /^ {2}cron:\s*$/.test(l));
  expect(service, 'не найден сервис cron в docker-compose.yml').toBeGreaterThan(0);
  let start = service;
  while (start > 0 && /^\s*#/.test(lines[start - 1]!)) start -= 1;
  return lines.slice(start, service);
}

/** Часть документации между двумя маркерами (включая строку начала, исключая конец). */
function docSection(startMarker: string, endMarker?: string): string {
  const lines = cronDocLines();
  const from = lines.findIndex((l) => l.includes(startMarker));
  expect(from, `в документации сервиса cron нет блока «${startMarker}»`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(from);
  const to = endMarker ? rest.findIndex((l, i) => i > 0 && l.includes(endMarker)) : -1;
  return (to > 0 ? rest.slice(0, to) : rest).join('\n');
}

describe('guard: паритет cron-роутов и crontab cron-контейнера', () => {
  it('каждая объявленная в TASKS задача присутствует в crontab docker-compose.yml', () => {
    const scheduled = new Set(scheduledEndpoints());
    const missing = declaredEndpoints().filter((e) => !scheduled.has(e));
    expect(missing, `задачи есть в коде, но их НЕ дёргает планировщик: ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('в crontab нет строк на задачи, которых нет в TASKS (иначе вечный 404)', () => {
    const declared = new Set(declaredEndpoints());
    const orphan = scheduledEndpoints().filter((e) => !declared.has(e));
    expect(orphan, `crontab дёргает несуществующие задачи: ${orphan.join(', ')}`).toEqual([]);
  });

  it('каждая задача прописана РОВНО один раз (дубль = двойной прогон воркера)', () => {
    const seen = new Map<string, number>();
    for (const e of scheduledEndpoints()) seen.set(e, (seen.get(e) ?? 0) + 1);
    const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([e]) => e);
    expect(dupes, `дублирующиеся строки crontab: ${dupes.join(', ')}`).toEqual([]);
  });

  it('каждая строка crontab: 5-полевое расписание, $$HIT с секретом, лог в /proc/1/fd/1', () => {
    for (const line of crontabLines()) {
      const m = /^echo "(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+\$\$HIT\s/.exec(line);
      expect(m, `строка crontab не в каноническом виде: ${line}`).toBeTruthy();
      // Экранирование `$$` обязательно: одинарный `$` съела бы интерполяция compose.
      expect(line, `строка без $$CDEK_CRON_URL: ${line}`).toContain('$$CDEK_CRON_URL');
      expect(line, `вывод не уходит в stdout контейнера: ${line}`).toContain('>/proc/1/fd/1 2>&1');
      expect(line, `одинарный $ съест интерполяция compose: ${line}`).not.toMatch(/[^$]\$[A-Z]/);
    }
  });

  it('секрет в crontab передаётся заголовком из env, а не литералом', () => {
    const hit = COMPOSE.split('\n').find((l) => l.includes("HIT='curl"));
    expect(hit, 'не найден HIT-хелпер cron-контейнера').toBeTruthy();
    expect(hit!).toContain('X-Cron-Secret: $$CDEK_CRON_SECRET');
  });

  /**
   * Документация — не «мелочь»: владелец может выбрать внешний планировщик (Timeweb,
   * системный cron хоста) и настроить магазин ровно по блоку «АЛЬТЕРНАТИВА». Если в нём
   * не хватает задачи, у такого магазина она НЕ выполняется — та же авария, что и
   * пропущенная строка crontab, только guard'у её видно лишь здесь.
   */
  it('блок «АЛЬТЕРНАТИВА» перечисляет те же задачи и в том же порядке, что crontab', () => {
    const alt = docSection('АЛЬТЕРНАТИВА');
    const listed = [...alt.matchAll(/\/api\/cron\/[a-z0-9-]+\/[a-z0-9-]+/g)].map((m) => m[0]!);
    expect(
      listed,
      'блок-документация внешнего планировщика расходится с crontab: ' +
        `в нём ${listed.length} задач(и), в crontab ${scheduledEndpointsInOrder().length}`,
    ).toEqual(scheduledEndpointsInOrder());
  });

  it('блок «КАК ЭТО РАБОТАЕТ» описывает каждую задачу из crontab', () => {
    const how = docSection('КАК ЭТО РАБОТАЕТ', 'ВКЛЮЧЕНИЕ');
    // Сверяем по «группа/задача»: одна лишь задача не годится — 'reconcile-pending'
    // является подстрокой 'reconcile-pending-paykeeper' и давала бы ложное «описано».
    const missing = scheduledEndpointsInOrder()
      .map((e) => e.replace('/api/cron/', ''))
      .filter((task) => !how.includes(task));
    expect(
      missing,
      `владельцу не объяснено, что делают задачи: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('крон-группа без динамического [task]-роута валит guard понятным текстом, а не ENOENT', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'cron-guard-'));
    mkdirSync(join(fixture, 'weird'), { recursive: true });
    writeFileSync(join(fixture, 'weird', 'route.ts'), "const TASKS = ['x'] as const;\n", 'utf8');

    let caught: unknown;
    try {
      declaredEndpoints(fixture);
    } catch (err) {
      caught = err;
    }
    expect(caught, 'guard обязан сообщить о непонятной раскладке, а не пройти молча').toBeInstanceOf(
      Error,
    );
    const message = (caught as Error).message;
    expect(message).toContain('weird');
    expect(message).toContain('[task]');
    expect(message, 'сырое ENOENT не объясняет автору, что делать').not.toContain('ENOENT');
  });
});
