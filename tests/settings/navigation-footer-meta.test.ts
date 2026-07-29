import { describe, expect, it } from 'vitest';

import {
  parseFooterMetaFormState,
  parseNavigationFormState,
} from '@/lib/settings/nav-form';
import { navigationSchema, SETTINGS_TR_FIELDS } from '@/lib/settings/schemas';
import { mergeSettings } from '@/lib/config/settings';
import { getEnv } from '@/lib/config/env';
import type { SettingRow } from '@/lib/settings/repository';

/**
 * Подвал витрины должен быть настраиваемым, а не захардкоженным (эталон
 * carrerusse.com, docs/41 §1): заголовок рассылки, приписка о согласии, копирайт
 * и кредит студии — содержимое КОНКРЕТНОГО магазина. Держим их в том же ключе
 * `navigation`, что и колонки футера: одна настройка = одна форма = один аудит.
 *
 * 🔴 ГЛАВНОЕ ТРЕБОВАНИЕ — АДДИТИВНОСТЬ. На живых стендах в `shop_settings` уже
 * лежат значения ключа `navigation` БЕЗ `footerMeta`. Если бы схема стала строже,
 * parseSettingValue вернул бы null и молча уронил ВСЮ навигацию магазина на
 * дефолты (класс дефекта exchange/gift — см. комментарий у displayCurrencySchema).
 */

describe('navigationSchema.footerMeta — аддитивное расширение', () => {
  it('прежнее значение БЕЗ footerMeta остаётся валидным (живые стенды не ломаются)', () => {
    const legacy = {
      header: [{ label: 'Каталог', href: '/catalog' }],
      footer: [{ title: 'Информация', links: [{ label: 'О нас', href: '/about' }] }],
    };
    const parsed = navigationSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.footerMeta).toBeUndefined();
  });

  it('полный footerMeta проходит схему', () => {
    const parsed = navigationSchema.safeParse({
      footer: [],
      footerMeta: {
        subscribeTitle: 'Рассылка магазина',
        subscribeNote: 'Согласие на обработку персональных данных',
        copyright: '2026 © Магазин',
        designedByLabel: 'Designed by — Studio',
        designedByHref: 'https://studio.example',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('частичный footerMeta валиден — каждое поле независимо', () => {
    expect(navigationSchema.safeParse({ footerMeta: { copyright: '2026 © X' } }).success).toBe(
      true,
    );
    expect(
      navigationSchema.safeParse({ footerMeta: { subscribeTitle: 'Новости' } }).success,
    ).toBe(true);
  });

  it('пустые строки схему не проходят (пусто = «не задано», ключ такого не хранит)', () => {
    expect(navigationSchema.safeParse({ footerMeta: { copyright: '' } }).success).toBe(false);
    expect(navigationSchema.safeParse({ footerMeta: { subscribeTitle: '   ' } }).success).toBe(
      false,
    );
  });

  it('битый designedByHref отбивается валидацией адреса', () => {
    expect(
      navigationSchema.safeParse({ footerMeta: { designedByHref: 'javascript:alert(1)' } })
        .success,
    ).toBe(false);
  });

  it('лишние поля отбрасываются (.strip — анти-tamper JSONB)', () => {
    const parsed = navigationSchema.safeParse({
      footerMeta: { copyright: '2026 © X', evil: '<script>' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data.footerMeta as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('переводимые поля подвала объявлены, адрес кредита — нет', () => {
  it('subscribeTitle/subscribeNote/copyright/designedByLabel переводятся', () => {
    const fields = SETTINGS_TR_FIELDS.navigation.footerMeta as readonly string[];
    expect([...fields].sort()).toEqual(
      ['copyright', 'designedByLabel', 'subscribeNote', 'subscribeTitle'].sort(),
    );
  });

  it('designedByHref в whitelist переводов НЕ входит (адрес — не текст)', () => {
    const fields = SETTINGS_TR_FIELDS.navigation.footerMeta as readonly string[];
    expect(fields).not.toContain('designedByHref');
  });
});

describe('parseFooterMetaFormState — поля админ-формы → значение настройки', () => {
  it('заполненные поля обрезаются и попадают в результат', () => {
    expect(
      parseFooterMetaFormState({
        subscribeTitle: '  Рассылка  ',
        copyright: '2026 © Магазин',
      }),
    ).toEqual({ subscribeTitle: 'Рассылка', copyright: '2026 © Магазин' });
  });

  it('ни одного заполненного поля → undefined (ключ в настройки не уходит)', () => {
    expect(parseFooterMetaFormState({})).toBeUndefined();
    expect(
      parseFooterMetaFormState({ subscribeTitle: '   ', copyright: '', designedByHref: '\t' }),
    ).toBeUndefined();
  });

  it('результат формы целиком проходит navigationSchema', () => {
    const state = parseNavigationFormState(
      'Каталог | /catalog',
      'Информация\nО нас | /about',
      { copyright: '2026 © Магазин', designedByLabel: 'Designed by — Studio' },
    );
    expect(state.footerMeta).toEqual({
      copyright: '2026 © Магазин',
      designedByLabel: 'Designed by — Studio',
    });
    expect(navigationSchema.safeParse(state).success).toBe(true);
  });

  it('вызов формы БЕЗ третьего аргумента даёт прежний результат (обратная совместимость)', () => {
    const state = parseNavigationFormState('Каталог | /catalog', '');
    expect(state).toEqual({ header: [{ label: 'Каталог', href: '/catalog' }], footer: [] });
    expect('footerMeta' in state).toBe(false);
  });
});

describe('mergeSettings — footerMeta всегда присутствует строками', () => {
  const env = () => getEnv({ NODE_ENV: 'test', SHOP_NAME: 'EnvShop', SHOP_CURRENCY: 'RUB' });

  it('ключа navigation в БД нет → все поля подвала = пустые строки', () => {
    const eff = mergeSettings(env(), []);
    expect(eff.navigation.footerMeta).toEqual({
      subscribeTitle: '',
      subscribeNote: '',
      copyright: '',
      designedByLabel: '',
      designedByHref: '',
    });
  });

  it('🔴 старое значение navigation БЕЗ footerMeta не роняет навигацию на дефолты', () => {
    const rows: SettingRow[] = [
      {
        setting_key: 'navigation',
        value: {
          header: [{ label: 'Каталог', href: '/catalog' }],
          footer: [{ title: 'Инфо', links: [{ label: 'О нас', href: '/about' }] }],
        },
      },
    ];
    const eff = mergeSettings(env(), rows);
    expect(eff.navigation.header).toHaveLength(1);
    expect(eff.navigation.footer).toHaveLength(1);
    expect(eff.navigation.footerMeta.copyright).toBe('');
  });

  it('заданные значения доезжают до эффективных настроек', () => {
    const rows: SettingRow[] = [
      {
        setting_key: 'navigation',
        value: { footerMeta: { copyright: '2026 © Магазин', designedByLabel: 'Studio' } },
      },
    ];
    const eff = mergeSettings(env(), rows);
    expect(eff.navigation.footerMeta.copyright).toBe('2026 © Магазин');
    expect(eff.navigation.footerMeta.designedByLabel).toBe('Studio');
    expect(eff.navigation.footerMeta.subscribeTitle).toBe('');
  });
});

describe('designedByHref — гвард адреса (кредит рендерится <a> на каждой странице)', () => {
  const ok = (href: string) =>
    navigationSchema.safeParse({ footerMeta: { designedByHref: href } }).success;

  it('путь от «/» и полный https:// — валидны', () => {
    expect(ok('/studio')).toBe(true);
    expect(ok('https://studio.example/about')).toBe(true);
  });

  it('javascript:/data: отбиваются (XSS)', () => {
    expect(ok('javascript:alert(1)')).toBe(false);
    expect(ok('data:text/html,<script>')).toBe(false);
  });

  it('http:// и protocol-relative отбиваются (mixed-content / скрытый редирект)', () => {
    expect(ok('http://studio.example')).toBe(false);
    expect(ok('//evil.example')).toBe(false);
  });
});
