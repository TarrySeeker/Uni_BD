import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Аудит №31 (major) — админка даёт 22 языка, витрина знает три; плашка ВРЁТ.
 *
 * ДЕФЕКТ. `LANGUAGE_LIBRARY` (22 языка) + `addCustomLocale` (любой BCP-47-тег) не
 * ограничены ничем. Витрина же (`storefront/lib/i18n.ts`) знает ровно
 * `LOCALES = ['ru','en','fr']`: `enabledLocalesFrom` МОЛЧА отбрасывает всё
 * остальное, а `app/[lang]/layout.tsx` уводит незнакомый/выключенный язык
 * 307-редиректом на дефолт. При этом жёлтая плашка формы утверждала ОБРАТНОЕ:
 * «выключенный здесь язык не исчезнет с витрины — страницы просто будут
 * показываться на языке по умолчанию». Владелец включал арабский и ждал арабскую
 * витрину; выключал английский и ждал, что /en останется. Оба ожидания ложны.
 *
 * РЕШЕНИЕ — вариант (б): свобода набора СОХРАНЕНА, UI говорит правду.
 * Обоснование мультитенантностью: набор языков ВИТРИНЫ — свойство конкретной
 * витрины (у неё свои словари и свой whitelist), а админка и БД — общая платформа,
 * обслуживающая разные витрины с разными наборами. Захардкодить в общей админке
 * ['ru','en','fr'] значило бы вшить в платформу набор ОДНОГО магазина — прямой
 * запрет CLAUDE.md. Ограничивать набор нечем: канала «какие языки умеет витрина»
 * у админки нет (это разные образы, выкатываются порознь).
 * Поэтому: набор остаётся свободным (он реально управляет вкладками перевода в
 * админке и ОТДАЁТСЯ витрине в settings.i18n.locales), а плашка перестаёт врать —
 * она сообщает ФАКТИЧЕСКОЕ поведение: выключённый язык с витрины УХОДИТ, а
 * включённый появится, только если витрина умеет этот язык.
 */

const ROOT = resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const LOCALES = ['ru', 'en', 'fr'] as const;
const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(read(`messages/${l}.json`)) as Record<string, unknown>]),
) as Record<(typeof LOCALES)[number], Record<string, unknown>>;

function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

const NOTICE_BODY = 'settings.languagesForm.storefrontNoticeBody';
const SUPPORT_HINT = 'settings.languagesForm.storefrontSupportHint';

describe('№31 — плашка про витрину больше НЕ врёт', () => {
  it('русский текст не утверждает, что выключенный язык остаётся на витрине', () => {
    const body = String(at(messages.ru, NOTICE_BODY));
    expect(body).not.toContain('не исчезнет с витрины');
    expect(body).not.toContain('ещё не читает');
  });

  it('английский и французский тексты тоже переписаны (не старое утверждение)', () => {
    expect(String(at(messages.en, NOTICE_BODY))).not.toContain('will not disappear');
    expect(String(at(messages.fr, NOTICE_BODY))).not.toContain('ne disparaîtra pas');
  });

  it('текст сообщает ФАКТ: выключение убирает язык с витрины', () => {
    // Ключевое утверждение — язык перестаёт быть доступен на сайте.
    expect(String(at(messages.ru, NOTICE_BODY))).toMatch(/витрин|сайт/i);
    expect(String(at(messages.ru, NOTICE_BODY))).toMatch(/выключ/i);
  });

  it('плейсхолдер {defaultLabel} сохранён во всех трёх локалях (компонент его подставляет)', () => {
    for (const l of LOCALES) {
      expect(String(at(messages[l], NOTICE_BODY))).toContain('{defaultLabel}');
    }
  });
});

describe('№31 — предупреждение про язык, которого витрина не умеет', () => {
  it('новый ключ storefrontSupportHint есть во всех трёх локалях админки (паритет)', () => {
    for (const l of LOCALES) {
      const v = at(messages[l], SUPPORT_HINT);
      expect(typeof v).toBe('string');
      expect(String(v).length).toBeGreaterThan(30);
    }
  });

  it('переводы — не копия русского (осмысленный перевод)', () => {
    const ru = String(at(messages.ru, SUPPORT_HINT));
    expect(String(at(messages.en, SUPPORT_HINT))).not.toBe(ru);
    expect(String(at(messages.fr, SUPPORT_HINT))).not.toBe(ru);
    // Латиница в en/fr — не кириллическая копия.
    expect(String(at(messages.en, SUPPORT_HINT))).not.toMatch(/[а-яё]/i);
    expect(String(at(messages.fr, SUPPORT_HINT))).not.toMatch(/[а-яё]/i);
  });

  it('текст не называет конкретные языки конкретного магазина (мультитенантность)', () => {
    for (const l of LOCALES) {
      const v = String(at(messages[l], SUPPORT_HINT));
      expect(v).not.toMatch(/\b(ru|en|fr)\b\s*[,/]\s*\b(ru|en|fr)\b/);
      expect(v).not.toMatch(/carre|erfgv/i);
    }
  });

  it('форма реально показывает подсказку (ключ не «мёртвый»)', () => {
    const form = read('app/admin/(panel)/settings/_components/LanguagesForm.tsx');
    expect(form).toContain('storefrontSupportHint');
    expect(form).toContain('storefrontNoticeBody');
  });
});

describe('№31 — свобода набора СОХРАНЕНА (мультитенантность платформы)', () => {
  const state = () => read('app/admin/(panel)/settings/_components/languages-form-state.ts');

  it('справочник платформы не урезан до трёх языков витрины carre', () => {
    const s = state();
    const codes = [...s.matchAll(/\{\s*code:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    expect(codes).toContain('ru');
    expect(codes).toContain('de');
  });

  it('ручное добавление произвольного тега по-прежнему работает', () => {
    expect(state()).toContain('addCustomLocale');
  });

  it('в справочник НЕ вшит whitelist витрины (нет импорта storefront/lib/i18n)', () => {
    expect(state()).not.toMatch(/storefront\/lib\/i18n/);
  });
});

describe('№31 — витрина по-прежнему честно фильтрует набор (регресс-страховка)', () => {
  const sf = () => read('storefront/lib/i18n.ts');

  it('enabledLocalesFrom пересекает набор магазина с whitelist витрины', () => {
    const s = sf();
    expect(s).toContain('enabledLocalesFrom');
    expect(s).toContain('isLocale');
  });

  it('fail-open сохранён: пустой/невалидный вход → весь whitelist (переключатель не пустеет)', () => {
    expect(sf()).toMatch(/out\.length > 0 \? out : \[\.\.\.LOCALES\]/);
  });
});
