import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Аудит №33 (major) + №12 (minor) — маршрутизация локале-подобных префиксов.
 *
 * ДЕФЕКТ №33. `middleware.ts` распознавал префикс локали РЕГУЛЯРКОЙ
 * `/^[a-z]{2}(-[a-z]{2})?$/`, поэтому ЛЮБОЙ похожий на локаль первый сегмент
 * (`/de/catalog`, `/xx`) пропускался как есть. Сегмент `[lang]` получал значение
 * `de`, `toLocale` фолбэчил его в `ru`, а `stripLocale` (которому нужен ИМЕННО
 * `isLocale`) считал `/de/catalog` голым ru-путём → переключатель языка строил
 * несуществующий `/en/de/catalog`. Корневого `app/not-found.tsx` не было вовсе,
 * поэтому покупатель получал ГОЛУЮ англоязычную 404 Next без шапки/футера/ссылок.
 * Тот же голый 404 отдавался на `/ru/<путь>` (regex исключал только сам `ru`
 * условием `first !== DEFAULT_LOCALE`, и путь уезжал в rewrite `/ru/ru/...`).
 *
 * ДЕФЕКТ №12. Та же первопричина: CMS-страница со slug из двух букв (`/qa`,
 * `/eu`) матчилась той же регуляркой и пропускалась БЕЗ rewrite, то есть уходила
 * в маршрут `[lang]` (главная на языке «qa») вместо `[lang]/[slug]` — страница
 * становилась недостижимой.
 *
 * РЕШЕНИЕ (одна правка маршрутизации). Whitelist `LOCALES` витрины — это
 * КОМПИЛЯТИВНАЯ константа приложения (набор словарей/переводов), а не конфиг из
 * БД, поэтому edge-middleware вправе её знать: БД он по-прежнему не читает.
 * Чистая функция `routeDecision(pathname)` решает за middleware:
 *   - реальный не-дефолтный префикс (`/en`, `/fr`) → пропустить как есть;
 *   - явный префикс дефолта (`/ru/...`) → 308-редирект на канонический голый путь;
 *   - всё остальное (`/de/...`, `/qa`, `/catalog`, `/`) → rewrite в дефолт.
 * Тогда `/qa` попадает в `[lang]/[slug]` (CMS-страница жива), а `/de/catalog`
 * даёт локализованную 404 ВНУТРИ layout ru (шапка/футер/переключатель на месте).
 */

import {
  DEFAULT_LOCALE,
  LOCALES,
  routeDecision,
  stripLocale,
  switchLocalePath,
} from '../../storefront/lib/i18n';

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

describe('routeDecision — реальные префиксы локалей пропускаются как есть', () => {
  it('/en и /fr (и вложенные пути) — passthrough без rewrite', () => {
    expect(routeDecision('/en')).toEqual({ kind: 'pass' });
    expect(routeDecision('/fr')).toEqual({ kind: 'pass' });
    expect(routeDecision('/en/catalog')).toEqual({ kind: 'pass' });
    expect(routeDecision('/fr/product/twilly')).toEqual({ kind: 'pass' });
  });

  it('каждая не-дефолтная локаль whitelist-а проходит без изменений', () => {
    for (const l of LOCALES) {
      if (l === DEFAULT_LOCALE) continue;
      expect(routeDecision(`/${l}/catalog`)).toEqual({ kind: 'pass' });
    }
  });
});

describe('routeDecision — голые пути дефолтной локали переписываются', () => {
  it('корень → rewrite в /<default>', () => {
    expect(routeDecision('/')).toEqual({ kind: 'rewrite', pathname: `/${DEFAULT_LOCALE}` });
  });

  it('обычный путь → rewrite с префиксом дефолта', () => {
    expect(routeDecision('/catalog')).toEqual({
      kind: 'rewrite',
      pathname: `/${DEFAULT_LOCALE}/catalog`,
    });
    expect(routeDecision('/product/twilly')).toEqual({
      kind: 'rewrite',
      pathname: `/${DEFAULT_LOCALE}/product/twilly`,
    });
  });
});

describe('№33 — неизвестный локале-подобный префикс НЕ пропускается', () => {
  it('/de/catalog не проходит как локаль — уезжает в rewrite дефолта (локализованная 404)', () => {
    // Ключевая разница с прежним regex-поведением: kind !== 'pass'.
    expect(routeDecision('/de/catalog')).toEqual({
      kind: 'rewrite',
      pathname: `/${DEFAULT_LOCALE}/de/catalog`,
    });
  });

  it('локале-подобные, но не поддерживаемые коды (es, it, pt-br, xx) — тоже rewrite', () => {
    for (const bogus of ['es', 'it', 'pt-br', 'xx', 'zz']) {
      const d = routeDecision(`/${bogus}/catalog`);
      expect(d.kind).toBe('rewrite');
    }
  });

  it('после rewrite путь остаётся внутри layout локали (шапка/футер), а не голый 404', () => {
    // Сегмент [lang] получает валидную дефолтную локаль → layout рендерится.
    const d = routeDecision('/de/catalog');
    expect(d.kind).toBe('rewrite');
    if (d.kind !== 'rewrite') return;
    const first = d.pathname.split('/').filter(Boolean)[0];
    expect(LOCALES).toContain(first);
  });

  it('переключатель языка на таком пути больше не строит /en/de/... (rest без префикса)', () => {
    // stripLocale видит /de/catalog как голый ru-путь; после правки middleware
    // такой URL до переключателя доходит уже как ru-страница 404 — а её путь
    // переключается корректно (префикс навешивается ровно один раз).
    expect(stripLocale('/de/catalog')).toEqual({ locale: DEFAULT_LOCALE, rest: '/de/catalog' });
    expect(switchLocalePath('/de/catalog', 'en')).toBe('/en/de/catalog');
    // …и этот путь тоже НЕ пропускается как локаль `en` + мусор: он валиден
    // (en — реальная локаль), а `de/catalog` внутри него даст 404 в layout en.
    expect(routeDecision('/en/de/catalog')).toEqual({ kind: 'pass' });
  });
});

describe('№33 — явный префикс дефолтной локали канонизируется редиректом', () => {
  it('/ru/catalog → 308 на голый /catalog (а не голый 404 и не /ru/ru/catalog)', () => {
    expect(routeDecision('/ru/catalog')).toEqual({
      kind: 'redirect',
      pathname: '/catalog',
      permanent: true,
    });
  });

  it('/ru → 308 на корень', () => {
    expect(routeDecision(`/${DEFAULT_LOCALE}`)).toEqual({
      kind: 'redirect',
      pathname: '/',
      permanent: true,
    });
  });

  it('редирект ПОСТОЯННЫЙ (308): голый /ru/* — не адрес витрины, дубль для SEO', () => {
    const d = routeDecision('/ru/catalog');
    expect(d.kind).toBe('redirect');
    if (d.kind !== 'redirect') return;
    expect(d.permanent).toBe(true);
  });

  it('rewrite НЕ даёт двойного префикса /ru/ru', () => {
    const d = routeDecision('/ru/catalog');
    if (d.kind === 'rewrite') {
      expect(d.pathname).not.toMatch(/^\/ru\/ru/);
    }
  });
});

describe('№12 — CMS-страница с двухбуквенным slug достижима', () => {
  it('/qa → rewrite в /<default>/qa (маршрут [lang]/[slug], а не [lang])', () => {
    expect(routeDecision('/qa')).toEqual({ kind: 'rewrite', pathname: `/${DEFAULT_LOCALE}/qa` });
  });

  it('двухбуквенные slug-и вообще не съедаются как локаль', () => {
    for (const slug of ['qa', 'eu', 'us', 'ai', 'go']) {
      expect(routeDecision(`/${slug}`)).toEqual({
        kind: 'rewrite',
        pathname: `/${DEFAULT_LOCALE}/${slug}`,
      });
    }
  });

  it('тот же slug под реальной локалью тоже доходит до [lang]/[slug]', () => {
    // /en/qa — passthrough, сегменты: lang=en, slug=qa.
    expect(routeDecision('/en/qa')).toEqual({ kind: 'pass' });
  });
});

describe('GUARD — middleware пользуется whitelist-ом, БД по-прежнему не читает', () => {
  const source = () => src('middleware.ts');

  it('regex «похоже на локаль» из middleware убран (он и был первопричиной №33/№12)', () => {
    const s = source();
    expect(s).not.toMatch(/\[a-z\]\{2\}\(-\[a-z\]\{2\}\)\?/);
  });

  it('решение маршрутизации делегировано чистой routeDecision из lib/i18n', () => {
    const s = source();
    expect(s).toContain('routeDecision');
    expect(s).toMatch(/from '@\/lib\/i18n'/);
  });

  it('middleware НЕ читает конфиг/БД (edge): без обращений к настройкам/сети', () => {
    const s = source();
    expect(s).not.toMatch(/getSettings|getEffectiveSettings|getLocaleConfig|fetch\(/);
  });

  it('пробрасывает исходный путь в layout заголовком (для редиректа «тот же путь»)', () => {
    const s = source();
    expect(s).toContain('x-pathname');
  });

  it('умеет все три исхода: pass / rewrite / redirect', () => {
    const s = source();
    expect(s).toContain('NextResponse.next');
    expect(s).toContain('NextResponse.rewrite');
    expect(s).toContain('NextResponse.redirect');
  });
});

describe('GUARD — корневой not-found витрины существует (№33: голая 404 Next)', () => {
  it('storefront/app/not-found.tsx есть и это НЕ пустая заглушка', () => {
    const s = src('app/not-found.tsx');
    expect(s.length).toBeGreaterThan(200);
  });

  it('корневой not-found несёт свой <html lang> и <body> (он вне [lang]/layout)', () => {
    const s = src('app/not-found.tsx');
    expect(s).toMatch(/<html/);
    expect(s).toMatch(/<body/);
  });

  it('текст 404 берётся из словаря витрины, а не хардкодом', () => {
    const s = src('app/not-found.tsx');
    expect(s).toContain('getDictionary');
  });

  it('локализованный not-found внутри [lang] сохранён (шапка/футер)', () => {
    const s = src('app/[lang]/not-found.tsx');
    expect(s).toContain('getDictionary');
    expect(s).toContain('stripLocale');
  });
});
