import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, it, expect } from 'vitest';

import { customerStatusLabelKey } from '@/app/admin/(panel)/customers/_components/guard';
import {
  BRANDING_TR_FIELD_DEFS,
  SEO_TR_FIELD_DEFS,
  CONTACTS_TR_FIELD_DEFS,
  buildHomeTrFieldDefs,
  buildNavigationTrFieldDefs,
} from '@/app/admin/(panel)/settings/_components/content-i18n-form-state';
import { addCustomLocale } from '@/app/admin/(panel)/settings/_components/languages-form-state';
import { buildGiftPayload } from '@/app/admin/(panel)/settings/gift/gift-form-state';
// Только ТИП: `import type` стирается компилятором, поэтому node-окружение теста
// не тянет React-компонент LocaleTabs.tsx.
import type { TranslatableFieldDef } from '@/app/admin/(panel)/_components/LocaleTabs';

/**
 * GUARD подписей ПАНЕЛИ ПЕРЕВОДОВ и остаточных русских литералов (ОЧАГ 4).
 *
 * WHY: владелец открывает вкладку перевода настроек на локали fr — и видит РУССКИЕ
 * подписи полей. Причина: у дескрипторов TranslatableFieldDef был только `label`
 * (готовая строка), поэтому LocaleTabs рендерил русский текст независимо от локали
 * оператора. Лечится ключом `labelKey` (+ ICU-параметрами для генераторов, где
 * подпись зависит от фактического наполнения массива: «Плитка 2», «Ссылка 3»).
 *
 * Тестов React-компонентов в проекте нет (vitest environment 'node'), поэтому:
 *   • чистые дескрипторы (content-i18n-form-state) проверяем ВЫЗОВОМ;
 *   • разметку и инлайновые дескрипторы форм сторожим чтением исходников
 *     (образец — tests/i18n/root-metadata.guard.test.ts);
 *   • эталон подписей — messages/ru.json, а не текст в коде.
 */

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const LOCALES = ['ru', 'en', 'fr'] as const;
const CYRILLIC_RE = /[А-Яа-яЁё]/;

/** Плоская карта 'a.b.c' → строка для каталога локали. */
function flatten(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (typeof obj === 'string') {
    out[prefix] = obj;
  }
  return out;
}

const catalogs = Object.fromEntries(
  LOCALES.map((l) => [l, flatten(JSON.parse(read(`messages/${l}.json`)))]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;

/** Имена ICU-аргументов строки: '{n}' → 'n'. */
function icuTokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const m of value.matchAll(/\{\s*([a-zA-Z0-9_]+)/g)) out.add(m[1]);
  return out;
}

/**
 * Убирает комментарии (`//…`, `/*…*\/`) — русские комментарии в проекте это стиль,
 * а не дефект. Кириллицу ищем только в КОДЕ.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// -----------------------------------------------------------------------------
// Дескрипторы настроек: полное наполнение (по 2 элемента в каждом массиве, чтобы
// генераторы развернули параметризованные подписи «пункт 1 / пункт 2»).
// -----------------------------------------------------------------------------

const HOME_FIXTURE = {
  hero: { title: 't', subtitle: 's', ctaLabel: 'c', ctaHref: '/x', imageKey: 'k' },
  about: { title: 'a', paragraphs: ['p1', 'p2'], values: ['v1', 'v2'] },
  quality: { title: 'q', items: ['i1', 'i2'] },
  delivery: {
    items: [
      { title: 'dt1', text: 'dx1' },
      { title: 'dt2', text: 'dx2' },
    ],
  },
  valuesStrip: {
    enabled: true,
    items: [
      { title: 'vt1', text: 'vx1' },
      { title: 'vt2', text: 'vx2' },
    ],
  },
  philosophy: { eyebrow: 'e', title: 'pt', text: 'px', linkLabel: 'll', linkHref: '/l' },
  looks: {
    enabled: true,
    title: 'lt',
    categories: [
      { title: 'ct1', text: 'cx1' },
      { title: 'ct2', text: 'cx2' },
    ],
  },
  tiles: { enabled: true, items: [{ title: 'tt1' }, { title: 'tt2' }] },
  video: { enabled: false, embedUrl: '' },
  designers: { enabled: true, title: 'dt', items: [{ name: 'n1' }, { name: 'n2' }] },
  slider: {
    enabled: true,
    slides: [
      { name: 'sn1', caption: 'sc1' },
      { name: 'sn2', caption: 'sc2' },
    ],
  },
  corpCert: { enabled: true, tiles: [{ title: 'cc1' }, { title: 'cc2' }] },
};

const NAV_FIXTURE = {
  header: [{ label: 'h1', href: '/1' }, { label: 'h2', href: '/2' }],
  footer: [
    { title: 'f1', links: [{ label: 'l1', href: '/l1' }, { label: 'l2', href: '/l2' }] },
    { title: 'f2', links: [{ label: 'l3', href: '/l3' }] },
  ],
};

const SETTINGS_DEFS: TranslatableFieldDef[] = [
  ...BRANDING_TR_FIELD_DEFS,
  ...SEO_TR_FIELD_DEFS,
  ...CONTACTS_TR_FIELD_DEFS,
  ...buildHomeTrFieldDefs(HOME_FIXTURE),
  ...buildNavigationTrFieldDefs(NAV_FIXTURE),
];

describe('панель переводов настроек: у каждого дескриптора есть переводимая подпись', () => {
  it('ни один дескриптор не несёт готовую строку-подпись (label)', () => {
    const offenders = SETTINGS_DEFS.filter((f) => 'label' in f).map((f) => f.key);
    expect(
      offenders,
      'Готовая подпись игнорирует локаль оператора — нужен labelKey:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('у каждого дескриптора непустой labelKey', () => {
    const offenders = SETTINGS_DEFS.filter(
      (f) => typeof f.labelKey !== 'string' || f.labelKey.trim() === '',
    ).map((f) => f.key);
    expect(offenders, `Без labelKey: ${offenders.join(', ')}`).toEqual([]);
  });

  it('каждый labelKey переведён в ru/en/fr непустой строкой', () => {
    const problems: string[] = [];
    for (const f of SETTINGS_DEFS) {
      for (const l of LOCALES) {
        const value = catalogs[l][f.labelKey];
        if (typeof value !== 'string' || value.trim() === '') {
          problems.push(`${f.labelKey} [${l}] — отсутствует`);
        }
      }
    }
    expect(problems, `Не резолвится:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('en/fr-подписи не русские (иначе это копипаста-заглушка)', () => {
    const problems: string[] = [];
    for (const f of SETTINGS_DEFS) {
      for (const l of ['en', 'fr'] as const) {
        if (CYRILLIC_RE.test(catalogs[l][f.labelKey] ?? '')) problems.push(`${f.labelKey} [${l}]`);
      }
    }
    expect(problems, `Русский текст в переводе:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('ICU-параметры подписи совпадают с labelParams дескриптора', () => {
    const problems: string[] = [];
    for (const f of SETTINGS_DEFS) {
      const tokens = icuTokens(catalogs.ru[f.labelKey] ?? '');
      const provided = new Set(Object.keys(f.labelParams ?? {}));
      for (const t of tokens) {
        if (!provided.has(t)) problems.push(`${f.key}: подпись ждёт {${t}}, а labelParams нет`);
      }
      for (const p of provided) {
        if (!tokens.has(p)) problems.push(`${f.key}: labelParams.${p} лишний для «${f.labelKey}»`);
      }
    }
    expect(problems, `Рассогласование параметров:\n  ${problems.join('\n  ')}`).toEqual([]);
  });

  it('нумерация в подписях человеческая (с 1), а не индекс массива', () => {
    const numbered = SETTINGS_DEFS.filter((f) => f.labelParams && 'n' in f.labelParams);
    expect(numbered.length).toBeGreaterThan(0);
    for (const f of numbered) {
      expect(Number(f.labelParams!.n), `${f.key}: номер должен начинаться с 1`).toBeGreaterThanOrEqual(1);
    }
    // Первый абзац блока «О бренде» — путь .0, а подпись «…1».
    const first = SETTINGS_DEFS.find((f) => f.key === 'about.paragraphs.0');
    expect(first?.labelParams?.n).toBe(1);
  });

  it('34 подписи панели переводов настроек покрыты ключами (ОЧАГ 4 закрыт целиком)', () => {
    const keys = new Set(SETTINGS_DEFS.map((f) => f.labelKey));
    expect(keys.size).toBe(34);
  });
});

// -----------------------------------------------------------------------------
// Исходники: русских user-facing литералов не осталось.
// -----------------------------------------------------------------------------

/** Файлы очага: подписи/сообщения обязаны идти ключами каталога. */
const SCANNED_FILES = [
  'app/admin/(panel)/_components/LocaleTabs.tsx',
  'app/admin/(panel)/settings/_components/content-i18n-form-state.ts',
  'app/admin/(panel)/settings/gift/gift-form-state.ts',
  'app/admin/(panel)/settings/_components/languages-form-state.ts',
  'app/admin/(panel)/catalog/_components/form-actions.ts',
  'app/admin/(panel)/customers/_components/guard.ts',
] as const;

/**
 * LANGUAGE_LIBRARY — эндонимы: название языка НА ЭТОМ ЖЕ языке («Русский»,
 * «Українська»). Они не переводятся принципиально, поэтому из проверки исключены.
 */
function stripLanguageLibrary(src: string): string {
  return src.replace(/LANGUAGE_LIBRARY[\s\S]*?\n\] as const;/, 'LANGUAGE_LIBRARY');
}

describe('очаг 4: в исходниках нет русских user-facing литералов', () => {
  for (const file of SCANNED_FILES) {
    it(`${file} — только ключи каталога`, () => {
      const code = stripLanguageLibrary(stripComments(read(file)));
      const lines = code
        .split('\n')
        .filter((l) => CYRILLIC_RE.test(l))
        .map((l) => l.trim());
      expect(
        lines,
        `${file}: русский литерал в коде — вынесите в messages/*:\n  ${lines.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});

describe('очаг 4: инлайновые дескрипторы форм переведены ключами', () => {
  /** Формы, где дескрипторы объявлены прямо в компоненте. */
  const INLINE_FORMS = [
    'app/admin/(panel)/news/_components/NewsForm.tsx',
    'app/admin/(panel)/gift-certificates/_components/GiftCertificateForm.tsx',
    'app/admin/(panel)/reviews/_components/ReviewReplyForm.tsx',
  ] as const;

  for (const file of INLINE_FORMS) {
    it(`${file} — дескрипторы несут labelKey, а не готовую строку`, () => {
      const src = stripComments(read(file));
      const block = /TR_FIELD_DEFS|FIELD_DEFS/.test(src) ? src : '';
      expect(block).not.toBe('');
      // Антипаттерн: label: t('…') внутри дескриптора (подпись уже переведена и
      // потому не типизируется как ключ; при смене локали не переедет).
      expect(src).not.toMatch(/\blabel:\s*t\(/);
      expect(src).toMatch(/labelKey:\s*'/);
    });
  }

  it('все labelKey исходников резолвятся в ru/en/fr', () => {
    const files = [...SCANNED_FILES, ...INLINE_FORMS];
    const problems: string[] = [];
    let found = 0;
    for (const file of files) {
      for (const m of read(file).matchAll(/labelKey:\s*'([^']+)'/g)) {
        found += 1;
        for (const l of LOCALES) {
          if (typeof catalogs[l][m[1]] !== 'string') problems.push(`${file}: ${m[1]} [${l}]`);
        }
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(problems, `Ключ подписи без перевода:\n  ${problems.join('\n  ')}`).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Попутные очаги: сообщения чистых модулей отдаются ключами.
// -----------------------------------------------------------------------------

describe('очаг 4 попутно: подарочные сертификаты — ошибка формы отдаётся ключом', () => {
  const cases = ['1.5', '1e3', '-5', String(Number.MAX_SAFE_INTEGER) + '0'];

  for (const raw of cases) {
    it(`«${raw}» → ключ каталога, а не русская строка`, () => {
      const res = buildGiftPayload({
        autoIssue: true,
        validDaysText: raw,
        categorySlugsText: '',
        allowIssueOnGiftPaidOrder: false,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(CYRILLIC_RE.test(res.error.key)).toBe(false);
      for (const l of LOCALES) {
        expect(typeof catalogs[l][res.error.key], `${res.error.key} [${l}]`).toBe('string');
      }
    });
  }
});

describe('очаг 4 попутно: языки — ошибка добавления тега отдаётся {key, params}', () => {
  it('мусорный тег → ключ с переводом во всех локалях', () => {
    const res = addCustomLocale(['ru'], 'русский');
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
    for (const l of LOCALES) expect(typeof catalogs[l][res.error!.key]).toBe('string');
    expect(icuTokens(catalogs.ru[res.error!.key]).size).toBe(0);
  });

  it('уже добавленный язык → ключ + параметр {code} (а не склеенная строка)', () => {
    const res = addCustomLocale(['ru', 'en'], 'EN');
    expect(res.ok).toBe(false);
    expect(res.error?.params).toEqual({ code: 'en' });
    for (const l of LOCALES) {
      const value = catalogs[l][res.error!.key];
      expect(typeof value, `${res.error!.key} [${l}]`).toBe('string');
      expect(icuTokens(value).has('code')).toBe(true);
    }
  });
});

describe('очаг 4 попутно: статус покупателя — подпись ключом customers.status.*', () => {
  for (const status of ['guest', 'active', 'disabled'] as const) {
    it(`«${status}» → customers.status.${status} во всех локалях`, () => {
      const key = customerStatusLabelKey(status);
      expect(key).toBe(`customers.status.${status}`);
      for (const l of LOCALES) expect(typeof catalogs[l][key!]).toBe('string');
    });
  }

  it('незнакомый статус → null (страница покажет сам код, без падения)', () => {
    expect(customerStatusLabelKey('whatever')).toBeNull();
  });

  it('страницы покупателей не рендерят подпись статуса напрямую', () => {
    for (const file of [
      'app/admin/(panel)/customers/page.tsx',
      'app/admin/(panel)/customers/[id]/page.tsx',
    ]) {
      const src = read(file);
      expect(src).toContain('customerStatusLabelKey');
      expect(src).not.toMatch(/customerStatusLabel\(/);
    }
  });
});

describe('очаг 4 попутно: «файл не выбран» — один ключ каталога на все загрузки', () => {
  const KEY = 'catalog.common.chooseFile';

  it('серверные обёртки каталога локализуют сообщение ключом', () => {
    const src = read('app/admin/(panel)/catalog/_components/form-actions.ts');
    expect(src).toContain(KEY);
    expect(src).not.toContain('Файл не выбран');
  });

  it(`${KEY} переведён в ru/en/fr`, () => {
    for (const l of LOCALES) expect(typeof catalogs[l][KEY]).toBe('string');
  });
});
