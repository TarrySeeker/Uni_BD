/**
 * Валидация ссылок в настройках магазина (hrefSchema).
 *
 * 🔴 ЗАЧЕМ ЭТОТ ФАЙЛ. Проверка ссылки писалась как защита от ОПЕЧАТОК («catolog»
 * без слэша, «www.site.ru» без протокола) и опиралась на `v.startsWith('/')`.
 * Но у этого условия есть последствие, которого никто не имел в виду:
 * `//evil.com` начинается со слэша и потому проходило.
 *
 * Браузер трактует `//host` как PROTOCOL-RELATIVE URL — то есть как внешний
 * адрес с текущей схемой. Такая строка в ссылке баннера главной или в пункте
 * меню шапки превращает настройку магазина в ОТКРЫТЫЙ РЕДИРЕКТ на чужой домен:
 * покупатель жмёт «Каталог» и уезжает на сайт злоумышленника, а ссылка при
 * этом выглядит внутренней.
 *
 * Сюда же обратный слэш: `/\evil.com` браузеры нормализуют к `//evil.com`,
 * и управляющие символы внутри пути дают тот же эффект после нормализации.
 *
 * Настройки правит администратор магазина, а не аноним, поэтому это не дыра
 * «на любой запрос» — но администратор не обязан знать про protocol-relative
 * URL, и подсунуть такую строку можно и через восстановление настроек из
 * чужого бэкапа, и по ошибке. Валидатор обязан отсекать это сам.
 */

import { describe, it, expect } from 'vitest';

import { SETTING_SCHEMAS } from '@/lib/settings/schemas';

/** Разбор ссылки через реальную схему настроек главной (там живёт ctaHref). */
function parseCtaHref(href: string) {
  const schema = SETTING_SCHEMAS['home'];
  return schema.safeParse({ hero: { ctaHref: href } });
}

describe('settings/hrefSchema — 🔴 protocol-relative и обратный слэш', () => {
  /**
   * 🔴 Главный кейс. Строка начинается со слэша, но ведёт НА ЧУЖОЙ ДОМЕН.
   */
  it('🔴 //evil.com отвергается (protocol-relative = внешний адрес)', () => {
    expect(parseCtaHref('//evil.com').success).toBe(false);
  });

  it('🔴 обратный слэш отвергается: браузер нормализует /\\host к //host', () => {
    expect(parseCtaHref('/\\evil.com').success).toBe(false);
    expect(parseCtaHref('\\\\evil.com').success).toBe(false);
  });

  it('🔴 управляющие символы внутри пути отвергаются', () => {
    // \t и \n выкидываются при нормализации URL, и /\t/evil.com становится
    // //evil.com — то есть внешним адресом.
    expect(parseCtaHref('/\t/evil.com').success).toBe(false);
    expect(parseCtaHref('/\n/evil.com').success).toBe(false);
  });

  it('javascript: и data: по-прежнему отвергаются', () => {
    expect(parseCtaHref('javascript:alert(1)').success).toBe(false);
    expect(parseCtaHref('data:text/html,<script>1</script>').success).toBe(false);
    // Регистр и пробелы не должны помогать обойти проверку.
    expect(parseCtaHref('  JaVaScRiPt:alert(1)').success).toBe(false);
  });

  it('законные ссылки продолжают проходить', () => {
    for (const ok of [
      '/catalog',
      '/#delivery',
      '/catalog?page=2',
      'https://example.ru',
      'http://example.ru/path',
      'mailto:shop@example.ru',
      'tel:+79990000000',
    ]) {
      expect(parseCtaHref(ok).success, `должно проходить: ${ok}`).toBe(true);
    }
  });

  it('опечатки, от которых защита ставилась изначально, всё ещё ловятся', () => {
    expect(parseCtaHref('catalog').success).toBe(false);
    expect(parseCtaHref('www.site.ru').success).toBe(false);
    expect(parseCtaHref('').success).toBe(false);
  });
});
