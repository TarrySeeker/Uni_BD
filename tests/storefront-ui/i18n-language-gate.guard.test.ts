import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// GUARD-тесты связки витрины с настройкой языков (волна 5). middleware/layout/
// SiteHeader/page — это Next/React-модули на алиасе '@/...'; юнит-тестами их не
// берём (environment 'node', алиас '@' в vitest указывает на КОРЕНЬ Admik, не на
// storefront). Сторожим СУТЬ механизма: enabled-набор реально прокинут в шапку,
// выключенный язык уводит ВРЕМЕННЫМ редиректом на дефолт, а антипаттерны
// (жёсткий LOCALES.map в переключателе, permanentRedirect, чтение БД в middleware)
// запрещены — иначе откат к константному набору прошёл бы мимо юнитов незаметно.

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

describe('middleware — распознаёт префикс локали regex-ом, БД не читает', () => {
  const source = () => src('middleware.ts');

  it('валидность языка НЕ решает по хардкод-массиву — используется regex ISO-кода', () => {
    const s = source();
    // Двухбуквенный код с опциональным регионом (ru, en, pt-br) — сегмент-локаль.
    expect(s).toMatch(/\[a-z\]\{2\}/);
  });

  it('похожий на локаль префикс пропускается, прочее rewrite в дефолтную локаль', () => {
    const s = source();
    expect(s).toContain('NextResponse.rewrite');
    expect(s).toContain('DEFAULT_LOCALE');
  });

  it('middleware НЕ читает конфиг/БД (edge): без обращений к настройкам/getSettings', () => {
    const s = source();
    expect(s).not.toMatch(/getSettings|getEffectiveSettings|getLocaleConfig|fetch\(/);
  });

  it('пробрасывает исходный путь в layout заголовком (для редиректа «тот же путь»)', () => {
    const s = source();
    expect(s).toContain('x-pathname');
  });
});

describe('layout — читает settings.i18n, уводит выключенный язык на дефолт', () => {
  const source = () => src('app/[lang]/layout.tsx');

  it('enabled-набор считается из настроек через enabledLocalesFrom', () => {
    const s = source();
    expect(s).toContain('enabledLocalesFrom');
    expect(s).toMatch(/settings\??\.?i18n/);
  });

  it('выключенный язык уводит ВРЕМЕННЫМ redirect() (НЕ permanentRedirect: 301 закрепит навсегда)', () => {
    const s = source();
    expect(s).toMatch(/redirect\(/);
    expect(s).not.toContain('permanentRedirect');
  });

  it('редирект гейтится на членство в enabled-наборе И на не-дефолтность (дефолт не редиректится)', () => {
    const s = source();
    // Условие вида: locale не в наборе И locale !== DEFAULT_LOCALE.
    expect(s).toMatch(/enabled[A-Za-z]*\.includes\(/);
    expect(s).toContain('DEFAULT_LOCALE');
  });

  it('редирект ведёт на тот же путь дефолтной локали (switchLocalePath)', () => {
    const s = source();
    expect(s).toContain('switchLocalePath');
  });

  it('enabled-набор прокинут в шапку пропсом', () => {
    const s = source();
    expect(s).toMatch(/enabledLocales=\{/);
  });

  it('generateStaticParams сведён к дефолтной локали (остальное force-dynamic)', () => {
    const s = source();
    expect(s).not.toMatch(/LOCALES\.map/);
    expect(s).toMatch(/generateStaticParams[\s\S]*DEFAULT_LOCALE/);
  });
});

describe('SiteHeader — переключатель по enabled-набору, не по константе LOCALES', () => {
  const source = () => src('app/[lang]/SiteHeader.tsx');

  it('оба переключателя (шапка + меню) мапят enabledLocales', () => {
    const s = source();
    const matches = s.match(/enabledLocales\.map/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('константный LOCALES.map в переключателе запрещён (иначе выключенный язык вернётся)', () => {
    const s = source();
    expect(s).not.toMatch(/LOCALES\.map/);
  });

  it('enabledLocales приходит пропсом', () => {
    const s = source();
    expect(s).toMatch(/enabledLocales/);
  });
});

describe('home page — generateStaticParams сведён к дефолтной локали', () => {
  const source = () => src('app/[lang]/page.tsx');

  it('не пререндерит все LOCALES (en/fr force-dynamic)', () => {
    const s = source();
    expect(s).not.toMatch(/LOCALES\.map/);
    expect(s).toMatch(/generateStaticParams[\s\S]*DEFAULT_LOCALE/);
  });
});
