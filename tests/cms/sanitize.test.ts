import { describe, expect, it } from 'vitest';

import { sanitizeHtml } from '@/lib/cms/sanitize';

/**
 * Тесты пакета 5.C-1 (docs/11 §5.1.6) — серверная санитизация rich-text.
 *
 * Анти-XSS инвариант 5.1: доверять клиентскому HTML нельзя. Вырезаются
 * script, on-обработчики и javascript:-ссылки; разрешённые теги остаются;
 * href нормализуется.
 * Функция чистая, без БД/сети — целиком тестируема юнитом.
 */

describe('cms/sanitize — sanitizeHtml (анти-XSS)', () => {
  it('вырезает <script>', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out).toContain('<p>ok</p>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('alert(1)');
  });

  it('удаляет on*-обработчики событий', () => {
    const out = sanitizeHtml('<p onclick="steal()">x</p>');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out.toLowerCase()).not.toContain('steal');
    expect(out).toContain('x');
  });

  it('вырезает javascript:-ссылки', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
    expect(out).toContain('click');
  });

  it('сохраняет разрешённые форматирующие теги', () => {
    const html =
      '<p>текст <strong>жирный</strong> <em>курсив</em></p>' +
      '<h2>Заголовок</h2><h3>Под</h3>' +
      '<ul><li>раз</li><li>два</li></ul>' +
      '<ol><li>один</li></ol>' +
      '<blockquote>цитата</blockquote>';
    const out = sanitizeHtml(html);
    for (const tag of ['<p>', '<strong>', '<em>', '<h2>', '<h3>', '<ul>', '<li>', '<ol>', '<blockquote>']) {
      expect(out, `пропал тег ${tag}`).toContain(tag);
    }
  });

  it('сохраняет переносы строк <br>', () => {
    const out = sanitizeHtml('<p>a<br>b</p>');
    expect(out.toLowerCase()).toMatch(/<br\s*\/?>/);
  });

  it('сохраняет безопасную ссылку с href', () => {
    const out = sanitizeHtml('<a href="https://example.com/page">link</a>');
    expect(out).toContain('href="https://example.com/page"');
    expect(out).toContain('link');
  });

  it('сохраняет относительную ссылку с href', () => {
    const out = sanitizeHtml('<a href="/catalog">каталог</a>');
    expect(out).toContain('href="/catalog"');
  });

  it('удаляет неразрешённые теги, но оставляет их текст', () => {
    const out = sanitizeHtml('<div><iframe src="evil"></iframe>видимый текст</div>');
    expect(out.toLowerCase()).not.toContain('<iframe');
    expect(out.toLowerCase()).not.toContain('<div');
    expect(out).toContain('видимый текст');
  });

  it('удаляет style-атрибуты (вектор CSS-инъекции)', () => {
    const out = sanitizeHtml('<p style="background:url(javascript:1)">x</p>');
    expect(out.toLowerCase()).not.toContain('style=');
    expect(out).toContain('x');
  });

  it('пустой/невалидный вход → пустая строка без падения', () => {
    expect(sanitizeHtml('')).toBe('');
    // sanitizeHtml принимает unknown — проверяем устойчивость к нестроковому входу.
    expect(sanitizeHtml(undefined)).toBe('');
    expect(sanitizeHtml(null)).toBe('');
    expect(sanitizeHtml(123)).toBe('');
  });

  it('вырезает data:-URI в href (вектор обхода)', () => {
    const out = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out.toLowerCase()).not.toContain('data:text/html');
  });

  it('чистая функция: повторный прогон идемпотентен', () => {
    const once = sanitizeHtml('<p>x</p><script>bad</script>');
    const twice = sanitizeHtml(once);
    expect(twice).toBe(once);
  });
});
