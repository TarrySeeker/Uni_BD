import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect, vi } from 'vitest';

/**
 * ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ дефолтов ключа настроек `gift`.
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ. Дефолты жили в двух местах: реестр настроек (его читает ФОРМА
 * в админке) и домен сертификатов (его читает РАНТАЙМ выпуска). Значения
 * разошлись, и после кнопки «Сбросить настройки сертификатов» (строка
 * shop_settings('gift') удаляется) форма рисовала «Создавать код автоматически»
 * ВКЛЮЧЁННЫМ, а выпуск денег на предъявителя был фактически ВЫКЛЮЧЕН. Владелец
 * был введён в заблуждение по механике выдачи денег.
 *
 * Сторожим ПРИЧИНУ, а не симптом:
 *  1) поведенчески — то, что рисует форма, обязано совпадать с тем, по чему
 *     работает прод-путь выпуска (productionAutoIssueDeps), на ОДНИХ И ТЕХ ЖЕ
 *     сырых значениях из БД, включая «строки нет»;
 *  2) структурно — в домене сертификатов не должно появиться СВОЕЙ копии
 *     дефолтов: повторное её появление обязано ронять тест.
 *
 * getSetting замокан (без БД), как в tests/payments/gift-auto-issue.repository.test.ts.
 */

const h = vi.hoisted(() => ({
  /** Сырое значение shop_settings('gift'); undefined = строки нет (после сброса). */
  value: undefined as unknown,
}));

vi.mock('@/lib/settings/repository', () => ({
  getSetting: async (key: string) =>
    key === 'gift' && h.value !== undefined ? { key, value: h.value, updatedAt: new Date() } : null,
}));

import { giftFormStateFrom } from '@/app/admin/(panel)/settings/gift/gift-form-state';
import { productionAutoIssueDeps } from '@/lib/gift-certificates/auto-issue';
import { giftValidDaysFor, giftValidUntil } from '@/lib/gift-certificates/origin';
import { GIFT_SETTINGS_DEFAULTS, parseSettingValue } from '@/lib/settings/schemas';

/** Ровно то, что кладёт в форму серверная страница settings/gift/page.tsx. */
function formSees(raw: unknown) {
  return giftFormStateFrom(parseSettingValue('gift', raw) ?? {});
}

/** Ровно то, по чему решает прод-путь автовыпуска (вебхук оплаты и крон). */
async function runtimeSees(raw: unknown) {
  h.value = raw;
  return productionAutoIssueDeps().getGiftSettings();
}

// =============================================================================
// 1) Поведение: форма и выпуск видят ОДНО И ТО ЖЕ.
// =============================================================================
describe('gift: дефолт формы == дефолт рантайма выпуска', () => {
  /** Сырые значения, которые реально встречаются в shop_settings.value. */
  const RAW_CASES: { name: string; raw: unknown }[] = [
    { name: 'строки нет (после «Сбросить настройки сертификатов»)', raw: undefined },
    { name: 'значение null', raw: null },
    { name: 'пустой объект (нет оверрайда)', raw: {} },
    // Ровно то, что сеет миграция 0056.
    { name: 'сид миграции 0056', raw: { autoIssue: true, allowIssueOnGiftPaidOrder: true } },
    { name: 'владелец выключил автовыпуск', raw: { autoIssue: false } },
    { name: 'свои разделы и срок', raw: { categorySlugs: ['podarki'], validDays: 365 } },
    { name: 'явно пустой список разделов', raw: { categorySlugs: [] } },
    { name: 'кривое значение из импорта', raw: { autoIssue: 'да', validDays: -7 } },
    { name: 'не объект вовсе', raw: 'сломано' },
  ];

  for (const { name, raw } of RAW_CASES) {
    it(`${name}: все четыре решения совпадают`, async () => {
      const form = formSees(raw);
      const runtime = await runtimeSees(raw);

      expect(form.autoIssue).toBe(runtime.autoIssue);
      expect(form.allowIssueOnGiftPaidOrder).toBe(runtime.allowIssueOnGiftPaidOrder);
      expect(form.categorySlugsText).toBe(runtime.categorySlugs.join(', '));
      // Форма показывает бессрочность пустым полем, рантайм — нулём.
      expect(form.validDaysText).toBe(runtime.validDays > 0 ? String(runtime.validDays) : '');
    });
  }

  it('после сброса настроек автовыпуск ВКЛЮЧЁН — как рисует форма и как сеет миграция 0056', async () => {
    const runtime = await runtimeSees(undefined);
    expect(runtime.autoIssue).toBe(true);
    expect(formSees(undefined).autoIssue).toBe(true);
    expect(GIFT_SETTINGS_DEFAULTS.autoIssue).toBe(true);
  });

  it('выключение автовыпуска владельцем доезжает до рантайма (тест не тавтологичен)', async () => {
    expect((await runtimeSees({ autoIssue: false })).autoIssue).toBe(false);
    expect(formSees({ autoIssue: false }).autoIssue).toBe(false);
  });
});

// =============================================================================
// 2) validDays: один тип, семантика «0 / отсутствие / null → бессрочно».
// =============================================================================
describe('gift.validDays — 0, отсутствие и null означают «бессрочно»', () => {
  const item = {
    id: 'i-1',
    nameSnapshot: 'Подарочный сертификат',
    skuSnapshot: 'GC',
    attributesSnapshot: {},
    unitPrice: '1000.00',
    quantity: 1,
    lineTotal: '1000.00',
  };
  const paidAt = new Date('2026-03-01T10:00:00Z');

  it('null из БД НЕ обнуляет весь раздел настроек (класс дефекта ключа exchange)', async () => {
    const runtime = await runtimeSees({
      autoIssue: false,
      validDays: null,
      categorySlugs: ['podarki'],
      allowIssueOnGiftPaidOrder: false,
    });
    // Если бы null ронял разбор, здесь молча появились бы дефолты платформы.
    expect(runtime.autoIssue).toBe(false);
    expect(runtime.allowIssueOnGiftPaidOrder).toBe(false);
    expect(runtime.categorySlugs).toEqual(['podarki']);
    expect(runtime.validDays).toBe(0);
  });

  it('0 / отсутствие / null → код бессрочный (validUntil = null)', async () => {
    for (const raw of [{ validDays: 0 }, {}, { validDays: null }]) {
      const settings = await runtimeSees(raw);
      const days = giftValidDaysFor(item, settings);
      expect(days, JSON.stringify(raw)).toBeNull();
      expect(giftValidUntil(paidAt, days), JSON.stringify(raw)).toBeNull();
    }
  });

  it('положительный срок доезжает до даты окончания (проверка не тавтологична)', async () => {
    const settings = await runtimeSees({ validDays: 30 });
    expect(giftValidDaysFor(item, settings)).toBe(30);
    expect(giftValidUntil(paidAt, giftValidDaysFor(item, settings))?.toISOString()).toBe(
      '2026-03-31T10:00:00.000Z',
    );
  });
});

// =============================================================================
// 3) GUARD: второго определения дефолтов быть не должно.
// =============================================================================
describe('guard: домен сертификатов не держит своей копии дефолтов', () => {
  const DOMAIN_DIR = resolve(__dirname, '../../lib/gift-certificates');

  /** Код без комментариев — сторожим исполняемый текст, а не документацию. */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const files = readdirSync(DOMAIN_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ name: f, code: stripComments(readFileSync(resolve(DOMAIN_DIR, f), 'utf8')) }));

  it('в каталоге есть что проверять (иначе гвард тавтологичен)', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it('АНТИПАТТЕРН: ни одного литерала дефолтов gift в lib/gift-certificates', () => {
    for (const { name, code } of files) {
      // Литерал вида `autoIssue: true/false` = вторая копия дефолта настройки.
      expect(code, `${name}: литерал дефолта autoIssue`).not.toMatch(
        /autoIssue\s*:\s*(?:true|false)/,
      );
      expect(code, `${name}: своя константа дефолтов`).not.toMatch(/DEFAULT_GIFT_SETTINGS/);
    }
  });

  it('механизм есть: прод-путь выпуска берёт настройки из реестра настроек', () => {
    const autoIssue = files.find((f) => f.name === 'auto-issue.ts');
    expect(autoIssue).toBeDefined();
    expect(autoIssue!.code).toMatch(
      /import\s*\{[^}]*resolveGiftSettings[^}]*\}\s*from\s*'@\/lib\/settings\/schemas'/,
    );
    expect(autoIssue!.code).toMatch(/resolveGiftSettings\(/);
  });

  it('дефолты объявлены РОВНО один раз — в реестре настроек', () => {
    const schemas = stripComments(
      readFileSync(resolve(__dirname, '../../lib/settings/schemas.ts'), 'utf8'),
    );
    expect(schemas.match(/GIFT_SETTINGS_DEFAULTS\s*[:=]\s*(?:Readonly|Object\.freeze)/g)).toHaveLength(
      1,
    );
  });
});
