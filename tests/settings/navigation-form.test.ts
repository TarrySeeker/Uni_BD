import { describe, it, expect } from 'vitest';

import { parseNavigationFormState } from '@/lib/settings/nav-form';
import { navigationSchema } from '@/lib/settings/schemas';

/**
 * C6 — UI-форма навигации.
 *
 * Чистый парсер текстовых полей формы (header/footer) в структуру навигации,
 * которую принимает navigationSchema (бэкенд + аудит уже протестированы в
 * tests/settings/home-settings.test.ts). Компонентного рендера нет (vitest
 * environment=node, без RTL) — покрываем чистую логику маппинга текста → JSON.
 */

describe('settings/nav-form — parseNavigationFormState (чистый парсер)', () => {
  it('строки шапки «Метка | /href» → массив пунктов, и собранное значение проходит navigationSchema', () => {
    const state = parseNavigationFormState('Каталог | /catalog\nДоставка | /delivery', '');

    expect(state.header).toEqual([
      { label: 'Каталог', href: '/catalog' },
      { label: 'Доставка', href: '/delivery' },
    ]);
    expect(navigationSchema.safeParse(state).success).toBe(true);
  });

  it('колонка футера: первая строка — заголовок, далее «Метка | href»', () => {
    const state = parseNavigationFormState(
      '',
      'Информация\nО нас | /about\nКонтакты | /contacts',
    );

    expect(state.footer).toEqual([
      {
        title: 'Информация',
        links: [
          { label: 'О нас', href: '/about' },
          { label: 'Контакты', href: '/contacts' },
        ],
      },
    ]);
    expect(navigationSchema.safeParse(state).success).toBe(true);
  });

  it('несколько колонок футера разделяются пустой строкой', () => {
    const state = parseNavigationFormState(
      '',
      'Магазин\nКаталог | /catalog\n\nСвязь\nПочта | mailto:a@b.ru',
    );

    expect(state.footer).toEqual([
      { title: 'Магазин', links: [{ label: 'Каталог', href: '/catalog' }] },
      { title: 'Связь', links: [{ label: 'Почта', href: 'mailto:a@b.ru' }] },
    ]);
    expect(navigationSchema.safeParse(state).success).toBe(true);
  });

  it('пустые textarea → {header:[],footer:[]} (фолбэк навигации витрины)', () => {
    const state = parseNavigationFormState('', '');
    expect(state).toEqual({ header: [], footer: [] });
    // пустая навигация валидна — витрина покажет дефолтное меню/футер.
    expect(navigationSchema.safeParse(state).success).toBe(true);
  });

  it('битые строки (без «|», пустые) отбрасываются', () => {
    const state = parseNavigationFormState('  \nПросто текст без разделителя\n  ', '   \n\n  ');
    expect(state).toEqual({ header: [], footer: [] });
  });

  it('невалидный href (опечатка без слэша) валит navigationSchema.safeParse', () => {
    const state = parseNavigationFormState('X | catolog', '');
    // парсер не валидирует href — это делает Zod на бэкенде; форма покажет ошибку.
    expect(state.header).toEqual([{ label: 'X', href: 'catolog' }]);
    expect(navigationSchema.safeParse(state).success).toBe(false);
  });
});
