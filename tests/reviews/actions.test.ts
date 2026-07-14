import { describe, expect, it, vi } from 'vitest';

import { createReviewActions, type ReviewActionDeps } from '@/lib/reviews/actions';
import type { ActionDeps } from '@/lib/server/action';
import type { AuthUser } from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import type { LocaleConfig } from '@/lib/i18n';
import type { Review, ReviewStatus } from '@/lib/reviews/types';

/**
 * ЮНИТ (без БД/Next): Server Actions модерации отзывов через createReviewActions с
 * инъецированными deps. Проверяет: guard reviews.write; модуль-гейт; машину
 * статусов (approve/reject/недопустимый переход); ответ (санитизация reply +
 * whitelist перевода); удаление; аудит/revalidate.
 */

const LOCALE: LocaleConfig = { defaultLocale: 'ru', locales: ['ru', 'en', 'fr'] };
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

function review(over: Partial<Review> = {}): Review {
  const D = new Date('2026-07-01T00:00:00Z');
  return {
    id: 'r1', productId: 'p1', customerId: null, authorName: 'Иван',
    body: 'текст', rating: 5, status: 'pending', reply: null, isVerified: false,
    source: 'storefront', translations: {}, createdAt: D, publishedAt: null,
    moderatedAt: null, moderatedBy: null, ...over,
  };
}

function reviewDeps(
  user: AuthUser | null,
  over: Partial<ReviewActionDeps> = {},
): ReviewActionDeps {
  return {
    actionDeps: actionDeps(user),
    isReviewsEnabled: vi.fn(async () => true),
    getLocaleConfig: vi.fn(async () => LOCALE),
    getReviewById: vi.fn(async () => review()),
    updateReviewStatus: vi.fn(async (id, status) => review({ id, status })),
    setReviewReply: vi.fn(async (id, reply, translations) =>
      review({ id, reply, translations }),
    ),
    deleteReview: vi.fn(async (id) => ({ id })),
    ...over,
  };
}

describe('reviews/actions — guard reviews.write', () => {
  it('не аутентифицирован → unauthorized', async () => {
    const deps = reviewDeps(null);
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'approved' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(deps.updateReviewStatus).not.toHaveBeenCalled();
  });

  it('нет права reviews.write → forbidden', async () => {
    const deps = reviewDeps(makeUser(['reviews.read']));
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'approved' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
  });
});

describe('reviews/actions — модуль-гейт', () => {
  it('модуль reviews выключен → отказ, updateReviewStatus не вызван', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']), {
      isReviewsEnabled: vi.fn(async () => false),
    });
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'approved' });
    expect(res.ok).toBe(false);
    expect(deps.updateReviewStatus).not.toHaveBeenCalled();
  });
});

describe('reviews/actions — модерация (машина статусов)', () => {
  it('pending→approved одобряет (updateReviewStatus вызван с moderator id)', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']), {
      getReviewById: vi.fn(async () => review({ status: 'pending' })),
    });
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'approved' });
    expect(res.ok).toBe(true);
    expect(deps.updateReviewStatus).toHaveBeenCalledWith(ID, 'approved', 'u-1');
    expect(deps.actionDeps.writeAudit).toHaveBeenCalledOnce();
  });

  it('pending→rejected отклоняет', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']), {
      getReviewById: vi.fn(async () => review({ status: 'pending' })),
    });
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'rejected' });
    expect(res.ok).toBe(true);
    expect(deps.updateReviewStatus).toHaveBeenCalledWith(ID, 'rejected', 'u-1');
  });

  it('approved→approved (нулевой переход) → отказ, updateReviewStatus НЕ вызван', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']), {
      getReviewById: vi.fn(async () => review({ status: 'approved' })),
    });
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'approved' });
    expect(res.ok).toBe(false);
    expect(deps.updateReviewStatus).not.toHaveBeenCalled();
  });

  it('несуществующий отзыв → not_found', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']), {
      getReviewById: vi.fn(async () => null),
    });
    const { setReviewStatus } = createReviewActions(deps);
    const res = await setReviewStatus({ id: ID, status: 'approved' });
    expect(res.ok).toBe(false);
  });
});

describe('reviews/actions — ответ магазина (reply + i18n)', () => {
  it('replyToReview санитайзит base reply и перевод reply (whitelist)', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']));
    const { replyToReview } = createReviewActions(deps);
    const res = await replyToReview({
      id: ID,
      reply: 'Спасибо<script>alert(1)</script>',
      translations: { en: { reply: 'Thanks<script>x</script>' } },
    });
    expect(res.ok).toBe(true);
    const call = (deps.setReviewReply as ReturnType<typeof vi.fn>).mock.calls[0];
    // baseReply санитайзен
    expect(call[1]).toBe('Спасибо');
    // translations reply санитайзен
    expect(call[2].en.reply).toBe('Thanks');
  });

  it('перевод не-whitelist поля (body) отбрасывается', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']));
    const { replyToReview } = createReviewActions(deps);
    const res = await replyToReview({
      id: ID,
      translations: { en: { reply: 'Thanks', body: 'HACK' } },
    });
    expect(res.ok).toBe(true);
    const call = (deps.setReviewReply as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[2].en.reply).toBe('Thanks');
    expect(call[2].en.body).toBeUndefined();
  });
});

describe('reviews/actions — удаление', () => {
  it('deleteReview вызывает репозиторий и аудит', async () => {
    const deps = reviewDeps(makeUser(['reviews.write']));
    const { deleteReview } = createReviewActions(deps);
    const res = await deleteReview({ id: ID });
    expect(res.ok).toBe(true);
    expect(deps.deleteReview).toHaveBeenCalledWith(ID);
    expect(deps.actionDeps.writeAudit).toHaveBeenCalledOnce();
  });
});
