import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { AuthUser } from '@/lib/auth/rbac';

/**
 * БАГ #4 (reliability): updateCmsPage не ловил нарушение уникального индекса slug
 * (PostgreSQL 23505). Ошибка всплывала как невнятный error:'internal' без текста —
 * владелец не понимал, что slug занят. CmsError НЕ наследует PublicActionError,
 * поэтому даже throw new CmsError('slug_conflict') стал бы 'internal'.
 *
 * ФИКС (минимальный, как createOrder для duplicate_code): ловим 23505 и бросаем
 * PublicActionError с понятным сообщением → пайплайн отдаёт
 * { ok:false, error:'validation', message }.
 *
 * Тест прогоняет реальный updateCmsPage (defineAction + default deps), мокая
 * только листовые модули: auth/session, audit, next-headers (через getRequestMeta
 * default), config/settings (гейт модуля) и db/client (sql бросает 23505 на UPDATE).
 */

const OWNER: AuthUser = {
  id: 'owner-1',
  email: 'owner@shop.io',
  isOwner: true,
  permissions: new Set(),
};

/** Имитация ошибки postgres.js: нарушение уникального индекса. */
class FakeUniqueViolation extends Error {
  code = '23505';
  constructor() {
    super('duplicate key value violates unique constraint "cms_pages_slug_key"');
    this.name = 'PostgresError';
  }
}

/** Валидный UUID v4 (Zod v4 .uuid() проверяет version/variant nibble). */
const VALID_ID = '48bd42cf-ada2-46ea-bc7d-eaba35828d74';

/**
 * tagged-template sql-мок: первый вызов (SELECT before) возвращает строку,
 * второй (UPDATE) бросает 23505.
 */
function makeSqlMock() {
  let call = 0;
  const sql = vi.fn(async () => {
    call += 1;
    if (call === 1) {
      return [{ id: VALID_ID, slug: 'old', title: 'Старое' }];
    }
    throw new FakeUniqueViolation();
  });
  return sql;
}

async function loadActions() {
  vi.resetModules();
  vi.doMock('@/lib/config/settings', () => ({
    isModuleEffectivelyEnabled: async () => true,
  }));
  vi.doMock('@/lib/db/client', () => ({ sql: makeSqlMock() }));
  vi.doMock('@/lib/auth/session', () => ({
    getCurrentUser: vi.fn(async () => OWNER),
  }));
  vi.doMock('@/lib/audit/log', () => ({
    writeAudit: vi.fn(async () => {}),
  }));
  vi.doMock('next/cache', () => ({ revalidatePath: vi.fn() }));
  vi.doMock('next/headers', () => ({
    headers: async () => new Map<string, string>(),
  }));
  return import('@/lib/cms/actions');
}

describe('updateCmsPage — коллизия slug (баг #4)', () => {
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

  it('23505 на UPDATE → ok:false, error:validation, понятный message (НЕ internal)', async () => {
    const { updateCmsPage } = await loadActions();
    const res = await updateCmsPage({ id: VALID_ID, slug: 'taken' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('ожидался отказ');
    expect(res.error).toBe('validation');
    expect(res.error).not.toBe('internal');
    expect(res.message).toBeTruthy();
    expect(res.message!.toLowerCase()).toContain('slug');
  });
});
