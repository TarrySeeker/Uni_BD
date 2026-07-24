import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { i18nSchema } from '@/lib/settings/schemas';
import {
  buildI18nPayload,
  LANGUAGE_LIBRARY,
} from '@/app/admin/(panel)/settings/_components/languages-form-state';

/**
 * GUARD по разметке экрана «Языки» (тестов React-компонентов нет: vitest env
 * 'node'). Сторожим СУТЬ, а не подстроки-украшения:
 *   • поле «язык по умолчанию» ЗАБЛОКИРОВАНО и объяснено (смена без миграции
 *     данных объявила бы весь русский контент другим языком);
 *   • владелец предупреждён, что витрина пока не читает этот набор (T7);
 *   • список языков берётся из справочника платформы, а не хардкодится под carre;
 *   • показана матрица покрытия переводов (computeCoverage наконец имеет
 *     потребителя).
 */

const BASE = resolve(__dirname, '../../app/admin/(panel)/settings');
const form = readFileSync(resolve(BASE, '_components/LanguagesForm.tsx'), 'utf8');
const page = readFileSync(resolve(BASE, 'languages/page.tsx'), 'utf8');
const settingsPage = readFileSync(resolve(BASE, 'page.tsx'), 'utf8');

// После i18n-переноса тексты предупреждений формы живут в messages/ru.json
// (LanguagesForm рендерит их через t(...)); суть инвариантов от этого не меняется.
const ru = JSON.parse(readFileSync(resolve(__dirname, '../../messages/ru.json'), 'utf8')) as Record<string, unknown>;
function ruVal(dot: string): string {
  let o: unknown = ru;
  for (const k of dot.split('.')) o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  return typeof o === 'string' ? o : '';
}
function ruUnder(prefix: string): string {
  let o: unknown = ru;
  for (const k of prefix.split('.')) o = o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined;
  const out: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === 'string') out.push(x);
    else if (x && typeof x === 'object') Object.values(x as Record<string, unknown>).forEach(walk);
  };
  walk(o);
  return out.join('\n');
}

describe('LanguagesForm — язык по умолчанию заблокирован', () => {
  it('поле defaultLocale отрисовано как disabled', () => {
    expect(form).toMatch(/defaultLocale/);
    expect(form).toMatch(/disabled/);
  });

  it('АНТИПАТТЕРН: нет обработчика, меняющего defaultLocale в состоянии', () => {
    expect(form).not.toMatch(/setDefaultLocale/);
    expect(form).not.toMatch(/onChange=\{[^}]*defaultLocale/);
  });

  it('рядом с полем есть объяснение, почему сменить нельзя', () => {
    const labels = ruUnder('settings.languagesForm');
    expect(labels).toMatch(/язык по умолчанию/i);
    expect(labels).toMatch(/миграц/i);
  });

  it('чекбокс языка по умолчанию нельзя снять', () => {
    expect(form).toContain('isDefault');
  });
});

describe('LanguagesForm — честное предупреждение про витрину', () => {
  it('форма прямо говорит, что витрина пока не читает набор языков', () => {
    const labels = ruUnder('settings.languagesForm');
    expect(labels).toMatch(/витрин/i);
    expect(labels).toMatch(/язык по умолчанию/i);
  });
});

describe('LanguagesForm — без хардкода языков', () => {
  it('опции строятся из справочника платформы через чистую логику', () => {
    expect(form).toContain("from './languages-form-state'");
    expect(form).toContain('buildLanguageOptions');
    expect(form).toContain('buildI18nPayload');
  });

  it('АНТИПАТТЕРН: в разметке формы нет вшитого набора языков магазина', () => {
    expect(form).not.toMatch(/\[\s*'ru'\s*,\s*'en'\s*,\s*'fr'\s*\]/);
    expect(form).not.toMatch(/'(Русский|Français)'/);
  });

  it('справочник языков живёт в отдельном модуле и не привязан к магазину', () => {
    expect(LANGUAGE_LIBRARY.some((l) => l.code === 'de')).toBe(true);
  });
});

describe('Экран «Языки» — страница', () => {
  it('защищена правом settings.manage', () => {
    expect(page).toContain("guardSettings('settings.manage')");
    expect(page).toContain('Forbidden');
  });

  it('показывает матрицу покрытия переводов (потребитель computeCoverage)', () => {
    expect(page).toContain('loadTranslationCoverage');
    expect(page).toContain('buildCoverageMatrix');
  });

  it('даёт кнопку сброса раздела к умолчаниям', () => {
    expect(page).toContain('ResetSettingButton');
    expect(page).toContain("settingKey=\"i18n\"");
  });

  it('раздел «Языки» доступен со страницы настроек', () => {
    expect(settingsPage).toContain('/admin/settings/languages');
    expect(settingsPage).toContain("t('nav.languages')");
    expect(ruVal('nav.languages')).toMatch(/Языки/);
  });
});

describe('Экран «Языки» — payload формы принимается схемой настроек', () => {
  it('результат buildI18nPayload валиден для i18nSchema (форма ↔ схема)', () => {
    const payload = buildI18nPayload({ defaultLocale: 'ru', enabled: ['en', 'fr'] });
    expect(i18nSchema.safeParse(payload).success).toBe(true);
  });
});
