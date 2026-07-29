import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getDictionary } from '../../storefront/lib/dictionaries';
import type { Locale } from '../../storefront/lib/i18n';

/**
 * GUARD разметки дополнительных CMS-страниц и блока «О нас» на главной
 * (эталон — слепок боевого carrerusse.com, docs/41 §3 и §4).
 *
 * ЧТО БЫЛО. `[slug]/page.tsx` рендерил одну колонку: крошки → `.page-title` с
 * `<h1>` → секции. Ни бокового меню разделов, ни двухколоночного макета эталона.
 * Блок «О нас» главной ставил слева `<h1>{about.title}</h1>`, а справа — только
 * абзацы: заголовка-фразы и её крупной подачи не было.
 *
 * ЧТО СТАЛО.
 *  • доп-страница: `.about` = `.about__left-col` (`.about__nav` со ссылками на
 *    соседние CMS-страницы) + `.about__right-col` (заголовок `.about__section-title`
 *    слева + секции). Пустой боковик схлопывается — контент на всю ширину;
 *  • главная: слева крупная фраза владельца (`home.about.title`), справа широкая
 *    колонка текста и ссылка «Наша история» (адрес — из данных).
 *
 * 🔴 МУЛЬТИТЕНАНТНОСТЬ. В обоих местах ни один заголовок, slug или адрес не зашит
 * в JSX — тест это и стережёт (см. «нет хардкода» ниже).
 */

const STOREFRONT = resolve(__dirname, '../../storefront');
const src = (rel: string) => readFileSync(resolve(STOREFRONT, rel), 'utf8');

const CMS_PAGE = 'app/[lang]/[slug]/page.tsx';
const HOME = 'app/[lang]/page.tsx';
const NAV = 'app/[lang]/components/PageNav.tsx';
const LOCALES: Locale[] = ['ru', 'en', 'fr'];

describe('доп-страница CMS — двухколоночный макет эталона', () => {
  const page = src(CMS_PAGE);
  const nav = src(NAV);

  it('обёртка и колонки названы классами эталона (.about / left-col / right-col)', () => {
    expect(page).toContain('className="about"');
    expect(page).toContain('about__left-col');
    expect(page).toContain('about__right-col');
  });

  it('боковое меню — отдельный компонент .about__nav со ссылками-пунктами', () => {
    expect(nav).toContain('about__nav');
    expect(nav).toContain('about__nav-item');
    expect(nav).toContain('about__nav-link');
  });

  it('текущий пункт подсвечен модификатором (а не переходом на самого себя вслепую)', () => {
    expect(nav).toContain('about__nav-link--current');
  });

  it('заголовок страницы — .about__section-title (слева), НЕ центрированный .page-title', () => {
    expect(page).toContain('about__section-title');
    expect(page).not.toContain('className="page-title"');
  });

  it('пустой боковик схлопывается: левая колонка рендерится по условию', () => {
    // Магазин с двумя страницами и без отмеченных пунктов не должен получить
    // пустую колонку в четверть экрана.
    expect(page).toMatch(/nav\.length\s*>\s*0/);
  });

  it('пункты боковика берутся из списка CMS-страниц, а не из литерала в коде', () => {
    expect(page).toContain('buildPageNav');
    expect(page).toContain('getPages');
  });

  // Комментарии из проверок исключаем: в них состав страниц carre упомянут как
  // пояснение к решению. Ловим именно КОД — литералы, которые попали бы в HTML.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const pageCode = stripComments(page);
  const navCode = stripComments(nav);

  it('🔴 нет хардкода slug-ов carre в разметке страницы и боковика', () => {
    for (const s of ['about', 'delivery', 'payment', 'policy', 'offer', 'contacts', 'corporate']) {
      expect(pageCode).not.toContain(`'/${s}'`);
      expect(navCode).not.toContain(`'/${s}'`);
    }
  });

  it('🔴 нет хардкода русских подписей разделов (они приходят из title страниц)', () => {
    for (const label of ['О нас', 'Доставка', 'Оплата', 'FAQ', 'Договор оферты']) {
      expect(navCode).not.toContain(label);
      expect(pageCode).not.toContain(label);
    }
  });

  it('крошки выпускают микроразметку BreadcrumbList (JSON-LD)', () => {
    expect(page).toContain('buildBreadcrumbJsonLd');
  });

  it('canonical/hreflang НЕ сломаны: alternatesFor остался в generateMetadata', () => {
    expect(page).toContain('alternatesFor');
    expect(page).toContain('meta.canonical');
  });
});

describe('главная — блок «О нас» по макету владельца', () => {
  const home = src(HOME);

  it('классы эталона сохранены (.mainpage--about_us + name/info)', () => {
    expect(home).toContain('mainpage--about_us');
    expect(home).toContain('mainpage--about_us-name');
    expect(home).toContain('mainpage--about_us-info');
  });

  it('слева — крупная фраза владельца из настроек (home.about.title), не «О нас» из словаря', () => {
    // Владелец подтвердил макет: слева «Carré Russe - искусство в вашем гардеробе».
    // Значение — из настроек магазина, поэтому в JSX стоит именно about.title.
    expect(home).toMatch(/mainpage--about_us-name[\s\S]{0,200}about\.title/);
  });

  it('ссылка «Наша история» ведёт по адресу ИЗ ДАННЫХ, а не по зашитому /about', () => {
    const code = home.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code).not.toContain("href('/about')");
    expect(code).toContain('aboutHref');
  });

  it('🔴 текст блока не хардкодится: абзацы приходят из настроек', () => {
    expect(home).toContain('aboutParagraphs');
    // Ни одной строки-литерала с текстом магазина в JSX. Комментарии не в счёт —
    // в них имя эталонного магазина упоминается как пояснение к решению, поэтому
    // ищем не подстроку, а именно строковый/JSX-литерал.
    const code = home.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/Carr[eé]\s*Russe/i);
    expect(code).not.toMatch(/искусство в вашем гардеробе/i);
  });
});

describe('словарь витрины — подписи интерфейса доп-страниц', () => {
  it('во всех локалях есть непустая подпись раздела боковика (aria/заголовок)', () => {
    for (const l of LOCALES) {
      const d = getDictionary(l);
      expect(d.cms.sectionsNavTitle.trim().length).toBeGreaterThan(0);
    }
  });

  it('«Наша история» и «Главная» переведены осмысленно (не копия ru)', () => {
    const ru = getDictionary('ru');
    const en = getDictionary('en');
    const fr = getDictionary('fr');

    expect(en.home.ourStory).not.toBe(ru.home.ourStory);
    expect(fr.home.ourStory).not.toBe(ru.home.ourStory);
    expect(en.common.home).not.toBe(ru.common.home);
    expect(fr.common.home).not.toBe(ru.common.home);
  });

  it('подпись боковика переведена на en/fr (не осталась русской)', () => {
    expect(getDictionary('en').cms.sectionsNavTitle).not.toBe(
      getDictionary('ru').cms.sectionsNavTitle,
    );
    expect(getDictionary('fr').cms.sectionsNavTitle).not.toBe(
      getDictionary('ru').cms.sectionsNavTitle,
    );
  });
});
