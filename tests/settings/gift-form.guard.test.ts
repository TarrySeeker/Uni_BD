import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

/**
 * GUARD по экрану «Настройки → Подарочные сертификаты» (тестов React-компонентов
 * нет: vitest env 'node'). Сторожим СУТЬ, а не оформление:
 *   • страница закрыта серверным гвардом settings.manage и не пререндерится;
 *   • мутация идёт единым пайплайном defineAction (право → Zod → upsert →
 *     revalidate → audit), а не сырым SQL из компонента;
 *   • есть сброс раздела к умолчаниям (ResetSettingButton по ключу gift);
 *   • клиентская форма не тянет серверные модули (утечка в бандл ловится только
 *     next build — здесь дешёвая страховка);
 *   • подписи — для владельца-нетехнаря, без жаргона;
 *   • раздел виден в оглавлении настроек.
 */

const BASE = resolve(__dirname, '../../app/admin/(panel)/settings');
const page = readFileSync(resolve(BASE, 'gift/page.tsx'), 'utf8');
const actions = readFileSync(resolve(BASE, 'gift/actions.ts'), 'utf8');
const form = readFileSync(resolve(BASE, 'gift/GiftSettingsForm.tsx'), 'utf8');
const settingsPage = readFileSync(resolve(BASE, 'page.tsx'), 'utf8');

describe('gift/page.tsx — доступ и рендер', () => {
  it('серверный гвард settings.manage + заглушка Forbidden', () => {
    expect(page).toContain("guardSettings('settings.manage')");
    expect(page).toContain('Forbidden');
    expect(page).toMatch(/if\s*\(\s*!guard\.ok\s*\)/);
  });

  it('force-dynamic: страница читает БД/cookies, статический пререндер запрещён', () => {
    expect(page).toContain("export const dynamic = 'force-dynamic'");
  });

  it('АНТИПАТТЕРН: страница не помечена клиентской', () => {
    expect(page).not.toContain("'use client'");
  });

  it('значения читаются из настроек магазина, а не хардкодятся', () => {
    expect(page).toContain("getSetting('gift')");
    expect(page).toContain("parseSettingValue('gift'");
  });

  it('есть сброс раздела к умолчаниям по ключу gift', () => {
    expect(page).toContain('ResetSettingButton');
    expect(page).toMatch(/settingKey="gift"|settingKey=\{'gift'\}/);
  });
});

describe('gift/actions.ts — пайплайн мутации', () => {
  it("модуль Server Actions: 'use server' в первой строке", () => {
    expect(actions.trimStart().startsWith("'use server'")).toBe(true);
  });

  it('мутация через defineAction с правом settings.manage', () => {
    expect(actions).toContain('defineAction');
    expect(actions).toContain("permission: 'settings.manage'");
  });

  it('вход валидируется схемой ключа gift (анти-tamper: клиенту не верим)', () => {
    expect(actions).toContain('giftSettingsSchema');
  });

  it('после записи — инвалидация кеша настроек и revalidate админки', () => {
    expect(actions).toContain('invalidateSettingsCache');
    expect(actions).toMatch(/revalidate:\s*\[/);
  });

  it('пишется аудит с before/after', () => {
    expect(actions).toMatch(/audit:\s*\{/);
    expect(actions).toContain('before');
    expect(actions).toContain('after');
  });

  it('АНТИПАТТЕРН: нет сырого SQL мимо репозитория настроек', () => {
    expect(actions).toContain('upsertSetting');
    expect(actions).not.toMatch(/from\s+'@\/lib\/db\/client'/);
    expect(actions).not.toMatch(/sql`/);
  });
});

describe('GiftSettingsForm.tsx — клиентская форма', () => {
  it("помечена 'use client'", () => {
    expect(form.trimStart().startsWith("'use client'")).toBe(true);
  });

  it('АНТИПАТТЕРН: не импортирует серверные модули (утечка в клиентский бандл)', () => {
    expect(form).not.toMatch(/from\s+'@\/lib\/db\//);
    expect(form).not.toMatch(/from\s+'@\/lib\/settings\/repository'/);
    expect(form).not.toMatch(/from\s+'@\/lib\/config\/settings'/);
    // Схемы/типы допустимы только как ТИПЫ — значения тянут zod в бандл формы.
    const valueImports = form.match(/^import\s+(?!type)[^;]*from\s+'@\/lib\/settings\/schemas'/m);
    expect(valueImports).toBeNull();
  });

  it('логика вынесена в чистые функции (они и покрыты юнитами)', () => {
    expect(form).toContain("from './gift-form-state'");
    expect(form).toContain('buildGiftPayload');
  });

  it('сохранение идёт через Server Action, а не fetch на самописный роут', () => {
    expect(form).toContain('updateGiftSettingsAction');
    expect(form).not.toMatch(/fetch\(/);
  });

  it('владелец видит все четыре решения: автовыпуск, срок, разделы каталога, обмен номинала', () => {
    expect(form).toContain('autoIssue');
    expect(form).toContain('validDaysText');
    expect(form).toContain('categorySlugsText');
    expect(form).toContain('allowIssueOnGiftPaidOrder');
  });

  it('подписи человеческие: без жаргона slug/JSON/boolean/API', () => {
    // Текст, который видит владелец, — без технических терминов.
    for (const jargon of ['slug', 'JSON', 'boolean', 'API', 'jsonb']) {
      expect(form.includes(`>${jargon}`), `жаргон «${jargon}» в подписи`).toBe(false);
    }
    expect(form).toMatch(/подароч/i);
    expect(form).toMatch(/бессрочн/i);
  });

  it('ошибка и успех сохранения показываются владельцу', () => {
    expect(form).toMatch(/role="alert"/);
    expect(form).toMatch(/role="status"/);
  });

  /**
   * Подпись про разделы каталога обязана описывать ТО, ЧТО КОД ДЕЛАЕТ.
   * Разделы работают на шаге ОФОРМЛЕНИЯ (lib/orders/repository →
   * applyGiftCategoryMarker кладёт маркер в снимок позиции), а выпуск решает уже
   * по маркеру (isGiftItemForAutoIssue). Поэтому пустой список НЕ выключает
   * выдачу кодов: товар с признаком сертификата в собственных атрибутах будет
   * помечен и без разделов, а единственный рубильник — галочка autoIssue.
   */
  it('подпись про разделы описывает реальный механизм: пометка ставится при оформлении заказа', () => {
    expect(form).toMatch(/помеча/i);
    expect(form).toMatch(/оформлени/i);
  });

  it('АНТИПАТТЕРН: форма не обещает, что пустой список разделов отключает выдачу кодов', () => {
    expect(form).not.toMatch(/пуст[^.]{0,160}(?:код|сертификат)[^.]{0,160}не\s+буд/i);
    expect(form).not.toMatch(/именно по ним создаётся код/i);
  });
});

describe('Настройки — раздел виден в оглавлении', () => {
  it('пункт «Подарочные сертификаты» есть в списке разделов и ведёт на свой экран', () => {
    expect(settingsPage).toMatch(/id: 'gift'/);
    expect(settingsPage).toContain('/admin/settings/gift');
  });
});
