import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: подписи для скринридеров на витрине переводятся вместе с интерфейсом.
 *
 * ЖИВАЯ НАХОДКА 2026-07-29 (стенд erfgv.website): на `/en/...` и `/fr/...` у
 * КАЖДОЙ карточки товара висело `aria-label="В избранное"` — русский текст на
 * английской и французской версиях. Незрячий покупатель-француз слышал русскую
 * подпись у каждого товара в каталоге.
 *
 * Причина — строки были зашиты прямо в компонент:
 *   aria-label={active ? 'Убрать из избранного' : 'В избранное'}
 * при том что у витрины есть собственный словарь (`storefront/lib/dictionaries.ts`)
 * с тремя локалями, и весь остальной интерфейс берёт подписи оттуда.
 *
 * Сторожим ПРИЧИНУ: кириллица в значении `aria-label` внутри JSX означает, что
 * подпись не проходит через словарь. Проверка идёт по всему дереву витрины —
 * так же выстрелит любой новый компонент, а не только исправленные два.
 */

const STOREFRONT_APP = join(process.cwd(), 'storefront/app');

/** Рекурсивно собирает .tsx-файлы витрины. */
function collectTsx(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectTsx(full, acc);
    } else if (entry.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

describe('GUARD: aria-label на витрине не содержит зашитой кириллицы', () => {
  const files = collectTsx(STOREFRONT_APP);

  it('находит файлы витрины (защита от пустого прогона)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('ни один aria-label не содержит русского текста прямо в JSX', () => {
    // Ловим строковый литерал в значении: aria-label="..." или aria-label={'...'}
    // (в т.ч. внутри тернарника). Значения из словаря/данных — без кавычек с
    // кириллицей — не совпадут.
    const ariaLiteral = /aria-label=\{?[^}\n]*?['"`]([^'"`\n]*[а-яА-ЯёЁ][^'"`\n]*)['"`]/g;

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(ariaLiteral)) {
        offenders.push(`${file.replace(process.cwd() + '/', '')}: ${m[1]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
