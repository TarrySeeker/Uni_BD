import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';
import { isValidSlug } from '@/lib/catalog/slug';

/**
 * БАГ (reliability, цикл 2): createCmsPage выводил slug через slugify(title).
 * slugify('🎉')/slugify('日本語') === '' (нет латиницы/кириллицы/цифр) → пустой
 * base → uniquifySlug('',0)==='' → INSERT писал ПУСТОЙ slug. Пустой slug ломает
 * ЧПУ страницы (NOT NULL/unique/роутинг по slug) — точно как было в каталоге до
 * фикса slugifyOrFallback (docs/05 §4.2).
 *
 * ФИКС: createCmsPage использует slugifyOrFallback(title, '', undefined, 'page')
 * — НИКОГДА не возвращает пустую строку (фолбэк `page-<token>`), результат всегда
 * проходит isValidSlug.
 *
 * Тест прогоняет реальный createCmsPage (defineAction + default deps), мокая
 * листовые модули и перехватывая slug, реально уходящий в INSERT.
 */

const OWNER: AuthUser = {
  id: 'owner-1',
  email: 'owner@shop.io',
  isOwner: true,
  permissions: new Set(),
};

/** Перехватывает первый интерполированный аргумент (slug) запроса INSERT. */
function makeSqlMock(captured: { slug?: string }) {
  return vi.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
    if (text.includes('INSERT INTO cms_pages')) {
      captured.slug = args[0] as string;
      return [{ id: 'new-page-id' }];
    }
    return [];
  });
}

async function loadActions(captured: { slug?: string }) {
  vi.resetModules();
  vi.doMock('@/lib/config/settings', () => ({
    isModuleEffectivelyEnabled: async () => true,
  }));
  vi.doMock('@/lib/db/client', () => ({ sql: makeSqlMock(captured) }));
  vi.doMock('@/lib/auth/session', () => ({
    getCurrentUser: vi.fn(async () => OWNER),
  }));
  vi.doMock('@/lib/audit/log', () => ({ writeAudit: vi.fn(async () => {}) }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
  vi.doMock('next/headers', () => ({
    headers: async () => new Map<string, string>(),
  }));
  return import('@/lib/cms/actions');
}

describe('createCmsPage — slug никогда не пустой (emoji/CJK-заголовок)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock('@/lib/config/settings');
    vi.doUnmock('@/lib/db/client');
    vi.doUnmock('@/lib/auth/session');
    vi.doUnmock('@/lib/audit/log');
    vi.doUnmock('next/cache');
    vi.doUnmock('next/headers');
    vi.resetModules();
  });

  it('заголовок из одних эмодзи → slug непустой и валидный (фолбэк page-…)', async () => {
    const captured: { slug?: string } = {};
    const { createCmsPage } = await loadActions(captured);

    const res = await createCmsPage({ title: '🎉🎉🎉' });

    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(captured.slug).toBeTruthy();
    expect(captured.slug).not.toBe('');
    expect(isValidSlug(captured.slug!)).toBe(true);
    expect(captured.slug!.startsWith('page-')).toBe(true);
  });

  it('заголовок CJK → slug непустой и валидный', async () => {
    const captured: { slug?: string } = {};
    const { createCmsPage } = await loadActions(captured);

    const res = await createCmsPage({ title: '日本語' });

    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(isValidSlug(captured.slug!)).toBe(true);
  });

  it('нормальный заголовок → читаемый slug (фолбэк НЕ срабатывает)', async () => {
    const captured: { slug?: string } = {};
    const { createCmsPage } = await loadActions(captured);

    const res = await createCmsPage({ title: 'О компании' });

    expect(res.ok).toBe(true);
    expect(captured.slug).toBe('o-kompanii');
  });
});
