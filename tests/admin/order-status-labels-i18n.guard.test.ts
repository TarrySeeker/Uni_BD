import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  DELIVERY_STATUSES,
} from '@/lib/orders/types';
import {
  orderStatusLabelKey,
  paymentStatusLabelKey,
  deliveryStatusLabelKey,
} from '@/lib/orders/labels';

/**
 * Аудит major №28/№35: админка печатала статусы заказа/оплаты/доставки жёстко
 * по-русски, в обход next-intl — оператор с интерфейсом на en/fr всё равно видел
 * русские бейджи, фильтры и подписи кнопок смены статуса.
 *
 * 🔴 ДВА НЕЗАВИСИМЫХ ЯЗЫКА. Язык ОПЕРАТОРА (админка, next-intl, cookie
 * NEXT_LOCALE) и язык ПОКУПАТЕЛЯ (витрина, префикс URL) не связаны: оператор
 * может смотреть fr, покупатель — en. Поэтому админка НЕ берёт готовый текст с
 * сервера, а резолвит КЛЮЧ каталога через t().
 */

const ROOT = join(__dirname, '../..');
const MESSAGES = join(ROOT, 'messages');
const CYRILLIC = /[А-Яа-яЁё]/;

type Json = Record<string, unknown>;

function catalog(locale: string): Json {
  return JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), 'utf8')) as Json;
}

/** Значение по дотированному ключу ('a.b.c'); отсутствует → undefined. */
function at(obj: Json, key: string): unknown {
  return key.split('.').reduce<unknown>(
    (acc, part) =>
      acc && typeof acc === 'object' ? (acc as Json)[part] : undefined,
    obj,
  );
}

const CATALOGS = { ru: catalog('ru'), en: catalog('en'), fr: catalog('fr') };

/** Все ключи статусов, которые обязана знать админка. */
const ALL_KEYS: string[] = [
  ...ORDER_STATUSES.map((s) => orderStatusLabelKey(s)),
  ...PAYMENT_STATUSES.map((s) => paymentStatusLabelKey(s)),
  ...DELIVERY_STATUSES.map((s) => deliveryStatusLabelKey(s)),
].filter((k): k is string => k !== null);

describe('каталог админки — подписи статусов есть во всех трёх языках', () => {
  it('ключ каждого доменного статуса присутствует в ru/en/fr и это строка', () => {
    expect(ALL_KEYS.length).toBe(
      ORDER_STATUSES.length + PAYMENT_STATUSES.length + DELIVERY_STATUSES.length,
    );
    for (const key of ALL_KEYS) {
      for (const locale of ['ru', 'en', 'fr'] as const) {
        const v = at(CATALOGS[locale], key);
        expect(typeof v, `${locale}: ${key}`).toBe('string');
        expect((v as string).trim().length, `${locale}: ${key} пуст`).toBeGreaterThan(0);
      }
    }
  });

  it('ru — по-русски, en/fr — БЕЗ кириллицы (не копия русского)', () => {
    for (const key of ALL_KEYS) {
      expect(CYRILLIC.test(at(CATALOGS.ru, key) as string), `ru: ${key}`).toBe(true);
      for (const locale of ['en', 'fr'] as const) {
        const v = at(CATALOGS[locale], key) as string;
        expect(CYRILLIC.test(v), `${locale}: ${key} — кириллица`).toBe(false);
      }
    }
  });

  it('en и fr — разные языки, а не одна копия', () => {
    const differing = ALL_KEYS.filter(
      (k) => at(CATALOGS.en, k) !== at(CATALOGS.fr, k),
    );
    expect(differing.length, 'fr — копия en').toBeGreaterThan(ALL_KEYS.length / 2);
  });

  it('подпись каталога совпадает по смыслу с серверной (единый источник, G-15)', () => {
    // Расхождение admin↔витрина уже было дефектом G-15 («Отправлен»/«Отгружен»).
    // Тексты берутся из одной таблицы, поэтому обязаны совпадать посимвольно.
    for (const s of ORDER_STATUSES) {
      const key = orderStatusLabelKey(s)!;
      for (const locale of ['ru', 'en', 'fr'] as const) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        expect(at(CATALOGS[locale], key)).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Guard по исходникам: ни один экран админки не печатает статус мимо next-intl.
// ---------------------------------------------------------------------------

const ADMIN_FILES = [
  'app/admin/(panel)/orders/_components/StatusBadges.tsx',
  'app/admin/(panel)/orders/_components/OrderFilters.tsx',
  'app/admin/(panel)/orders/_components/OrderActionsPanel.tsx',
  'app/admin/(panel)/orders/[id]/page.tsx',
  'app/admin/(panel)/customers/[id]/page.tsx',
];

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Убирает комментарии — русские комментарии это стиль проекта, а не дефект. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('🔴 экраны админки не зовут серверные подписи напрямую (major №28, №35)', () => {
  for (const file of ADMIN_FILES) {
    it(`${file} — без прямого вызова *StatusLabel(...)`, () => {
      const src = stripComments(read(file));
      expect(
        src,
        'прямой вызов серверной подписи в обход локали оператора',
      ).not.toMatch(/(?<!Key)\b(order|payment|delivery)StatusLabel\s*\(/i);
    });

    it(`${file} — резолвит подпись через t() по ключу`, () => {
      const src = stripComments(read(file));
      expect(src, 'ключи статусов не используются').toMatch(
        /StatusLabelKey|orders\.statusLabels/,
      );
    });
  }
});

describe('StatusBadges — бейджи локализованы для оператора', () => {
  const src = read(ADMIN_FILES[0]);

  it('получает переводчик next-intl (сервер) и остаётся единым компонентом', () => {
    expect(src).toMatch(/getTranslations|useTranslations/);
    expect(src, 'цвет-классы бейджей потеряны').toMatch(/StatusBadgeClass/);
  });

  it('незнакомый статус не падает и печатается сам код (фолбэк сохранён)', () => {
    // Ключа нет → показываем код, а не пустой бейдж и не аварию.
    expect(orderStatusLabelKey('weird')).toBeNull();
    expect(src).toMatch(/\?\s*t\(|:\s*status/);
  });
});
