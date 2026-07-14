import { describe, expect, it, vi } from 'vitest';

import { createNewsActions, type NewsActionDeps } from '@/lib/news/actions';
import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import type { LocaleConfig } from '@/lib/i18n';
import type { NewsArticle, NewsStatus } from '@/lib/news/types';

/**
 * ЮНИТ (без БД/Next): Server Actions новостей через createNewsActions с
 * инъецированными deps. Проверяет: guard news.write; модуль-гейт; санитизацию
 * body; whitelist переводов; машину статусов (публикация/недопустимый переход);
 * аудит/revalidate.
 */

const LOCALE: LocaleConfig = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };
/** Валидный UUID (Zod требует variant-nibble [89ab]) для schema-валидируемых входов. */
const ID = '11111111-1111-4111-8111-111111111111';

function makeUser(perms: PermissionCode[], isOwner = false): AuthUser {
  return { id: 'u-1', email: 'u@shop.io', isOwner, permissions: new Set(perms) };
}

function actionDeps(user: AuthUser | null): ActionDeps {
  return {
    getCurrentUser: vi.fn(async () => user),
    writeAudit: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    getRequestMeta: vi.fn(async () => ({ ip: '127.0.0.1', userAgent: 'vitest' })),
  };
}

function article(over: Partial<NewsArticle> = {}): NewsArticle {
  const D = new Date('2026-07-01T00:00:00Z');
  return {
    id: 'n1', slug: 'welcome', title: 'Привет', groupLabel: null, excerpt: null,
    body: null, coverImageKey: null, status: 'draft', publishedAt: null, sortOrder: 0,
    seoTitle: null, seoDescription: null, ogTitle: null, ogDescription: null,
    ogImageKey: null, noindex: false, canonicalUrl: null, translations: {},
    createdBy: null, updatedBy: null, createdAt: D, updatedAt: D, ...over,
  };
}

function newsDeps(
  user: AuthUser | null,
  over: Partial<NewsActionDeps> = {},
): NewsActionDeps {
  return {
    actionDeps: actionDeps(user),
    isNewsEnabled: vi.fn(async () => true),
    getLocaleConfig: vi.fn(async () => LOCALE),
    insertNews: vi.fn(async () => ({ id: 'n-new' })),
    updateNews: vi.fn(async (row) => article({ id: row.id })),
    updateNewsStatus: vi.fn(async (id, status) => article({ id, status })),
    deleteNews: vi.fn(async (id) => ({ id, slug: 'welcome' })),
    getNewsById: vi.fn(async () => article()),
    ...over,
  };
}

describe('news/actions — guard news.write', () => {
  it('не аутентифицирован → unauthorized, insert не вызван', async () => {
    const deps = newsDeps(null);
    const { createNews } = createNewsActions(deps);
    const res = await createNews({ title: 'X' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(deps.insertNews).not.toHaveBeenCalled();
  });

  it('нет права news.write → forbidden', async () => {
    const deps = newsDeps(makeUser(['news.read']));
    const { createNews } = createNewsActions(deps);
    const res = await createNews({ title: 'X' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });

  it('право есть → создаёт, пишет аудит и revalidate', async () => {
    const deps = newsDeps(makeUser(['news.write']));
    const { createNews } = createNewsActions(deps);
    const res = await createNews({ title: 'Новость' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBe('n-new');
    expect(deps.insertNews).toHaveBeenCalledOnce();
    expect(deps.actionDeps.writeAudit).toHaveBeenCalledOnce();
    expect(deps.actionDeps.revalidate).toHaveBeenCalled();
  });
});

describe('news/actions — модуль-гейт', () => {
  it('модуль news выключен → internal (NewsError module_disabled), insert не вызван', async () => {
    const deps = newsDeps(makeUser(['news.write']), { isNewsEnabled: vi.fn(async () => false) });
    const { createNews } = createNewsActions(deps);
    const res = await createNews({ title: 'X' });
    expect(res.ok).toBe(false);
    expect(deps.insertNews).not.toHaveBeenCalled();
  });
});

describe('news/actions — санитизация body', () => {
  it('createNews вырезает <script> из body перед вставкой', async () => {
    const deps = newsDeps(makeUser(['news.write']));
    const { createNews } = createNewsActions(deps);
    await createNews({ title: 'X', body: '<p>ok</p><script>alert(1)</script>' });
    const arg = (deps.insertNews as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.body).toContain('<p>ok</p>');
    expect(arg.body).not.toContain('<script>');
  });
});

describe('news/actions — публикация и машина статусов', () => {
  it('setNewsStatus draft→published проставляет статус (updateNewsStatus вызван)', async () => {
    const deps = newsDeps(makeUser(['news.write']), {
      getNewsById: vi.fn(async () => article({ status: 'draft' })),
    });
    const { setNewsStatus } = createNewsActions(deps);
    const res = await setNewsStatus({ id: ID, status: 'published' });
    expect(res.ok).toBe(true);
    expect(deps.updateNewsStatus).toHaveBeenCalledWith(ID, 'published', 'u-1');
  });

  it('archived→published напрямую → invalid_transition (updateNewsStatus НЕ вызван)', async () => {
    const deps = newsDeps(makeUser(['news.write']), {
      getNewsById: vi.fn(async () => article({ status: 'archived' })),
    });
    const { setNewsStatus } = createNewsActions(deps);
    const res = await setNewsStatus({ id: ID, status: 'published' });
    expect(res.ok).toBe(false);
    expect(deps.updateNewsStatus).not.toHaveBeenCalled();
  });

  it('setNewsStatus для несуществующей → not_found', async () => {
    const deps = newsDeps(makeUser(['news.write']), { getNewsById: vi.fn(async () => null) });
    const { setNewsStatus } = createNewsActions(deps);
    const res = await setNewsStatus({ id: ID, status: 'published' });
    expect(res.ok).toBe(false);
  });
});

describe('news/actions — переводы (whitelist)', () => {
  it('updateNews прокидывает translations (en) и санитайзит body оверлея', async () => {
    const deps = newsDeps(makeUser(['news.write']), {
      getNewsById: vi.fn(async () => article()),
    });
    const { updateNews } = createNewsActions(deps);
    const res = await updateNews({
      id: ID,
      translations: { en: { title: 'Hello', body: '<p>hi</p><script>x</script>' } },
    });
    expect(res.ok).toBe(true);
    const arg = (deps.updateNews as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.translationsProvided).toBe(true);
    expect(arg.translations.en.title).toBe('Hello');
    expect(arg.translations.en.body).not.toContain('<script>');
  });
});

describe('news/actions — удаление', () => {
  it('deleteNews вызывает репозиторий и аудит', async () => {
    const deps = newsDeps(makeUser(['news.write']));
    const { deleteNews } = createNewsActions(deps);
    const res = await deleteNews({ id: ID });
    expect(res.ok).toBe(true);
    expect(deps.deleteNews).toHaveBeenCalledWith(ID);
  });
});
