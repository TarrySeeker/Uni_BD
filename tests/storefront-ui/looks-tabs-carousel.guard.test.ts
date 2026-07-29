import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD: блок «Образы» на главной = вкладки-категории + карусель карточек.
 *
 * Витрина — Next/React-модули, которые vitest здесь не рендерит (RTL в проекте нет),
 * поэтому сторожим СУТЬ чтением исходника, как соседние guard-ы витрины.
 *
 * Требования, которые обязаны пережить любую последующую правку:
 *  - вкладки доступны (role=tablist/tab + aria-selected), кнопка листания с aria-label;
 *  - карусель БЕЗ внешних библиотек: CSS scroll-snap + scrollBy (CSP/бандл);
 *  - SSR-дружественность: карточки активной вкладки в разметке (не только после JS),
 *    т.е. НЕТ гейта вида `if (!mounted) return null` и фото/имена рендерятся всегда;
 *  - подписи UI — из словаря витрины (ru/en/fr), а не хардкод в компоненте;
 *  - null-safety: списки читаются через `?? []` (storefront исключён из tsconfig).
 */

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

const COMPONENT = 'app/[lang]/components/LooksCarousel.tsx';

describe('LooksCarousel — клиентский компонент вкладок и карусели', () => {
  const source = () => src(COMPONENT);

  it("объявлен клиентским ('use client')", () => {
    expect(source().startsWith("'use client'")).toBe(true);
  });

  it('вкладки доступны: role=tablist / role=tab / aria-selected', () => {
    const s = source();
    expect(s).toContain('role="tablist"');
    expect(s).toContain('role="tab"');
    expect(s).toContain('aria-selected');
  });

  it('кнопка листания несёт aria-label (не безымянная иконка)', () => {
    expect(source()).toMatch(/aria-label=\{[^}]*next[^}]*\}/i);
  });

  it('карусель на scrollBy — без внешних библиотек каруселей', () => {
    const s = source();
    expect(s).toContain('scrollBy');
    // Никаких импортов слайдеров/каруселей/jQuery.
    expect(s).not.toMatch(/from '(swiper|slick|keen-slider|embla|react-slick|jquery)/i);
  });

  it('SSR-дружественность: нет гейта «рендерим только после mount»', () => {
    const s = source();
    expect(s).not.toMatch(/if\s*\(\s*!\s*mounted\s*\)/);
    expect(s).not.toMatch(/typeof window === 'undefined'\s*\)\s*return null/);
  });

  it('у фото образа осмысленный alt (имя автора), а не пустой', () => {
    expect(source()).toMatch(/alt=\{[^}]*authorName[^}]*\}/);
  });

  it('подписи интерфейса приходят пропом-словарём, не хардкодом в компоненте', () => {
    const s = source();
    // Никакой кириллицы в JSX-строках компонента (контент и подписи — снаружи).
    const jsxText = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(jsxText).not.toMatch(/[а-яА-ЯёЁ]/);
  });

  it('null-safety: списки читаются через `?? []`', () => {
    const s = source();
    expect(s).toContain('?? []');
  });
});

describe('главная — секция «Образы» рендерит новый компонент', () => {
  const source = () => src('app/[lang]/page.tsx');

  it('импортирует LooksCarousel', () => {
    expect(source()).toMatch(/import \{ LooksCarousel \} from '\.\/components\/LooksCarousel'/);
  });

  it('старая статичная сетка (lookbook__row/anons) убрана', () => {
    const s = source();
    expect(s).not.toContain('lookbook__row');
    expect(s).not.toContain('lookbook__anons');
  });

  it('доступ к настройкам через глубокий optional chaining + `?? []`', () => {
    const s = source();
    expect(s).toContain('settings?.home?.looks');
    expect(s).toMatch(/looks\?\.items \?\? \[\]/);
    expect(s).toMatch(/looks\?\.categories \?\? \[\]/);
  });
});

describe('dictionaries — подписи блока «Образы» во всех локалях', () => {
  const source = () => src('lib/dictionaries.ts');

  it('ключи looksNext/looksTabsAria объявлены и переведены в ru/en/fr', () => {
    const s = source();
    for (const key of ['looksNext', 'looksTabsAria']) {
      const matches = s.match(new RegExp(key, 'g')) ?? [];
      // тип + ru + en + fr
      expect(matches.length, `ключ ${key} должен быть в типе и трёх локалях`).toBeGreaterThanOrEqual(4);
    }
  });
});
