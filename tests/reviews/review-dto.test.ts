import { describe, expect, it } from 'vitest';

import {
  toPublicReviewDto,
  toReviewAggregateDto,
} from '@/lib/storefront/review-dto';
import type { ApprovedReviewRow, ReviewAggregate } from '@/lib/reviews/types';

/**
 * ЮНИТ (без БД): публичные DTO отзывов (docs/24 §4). Скрытие внутренних полей;
 * локализация ТОЛЬКО reply (UGC body/author не переводится); агрегат до 1 знака.
 */

function row(over: Partial<ApprovedReviewRow> = {}): ApprovedReviewRow {
  const D = new Date('2026-07-01T00:00:00Z');
  return {
    id: 'r1', authorName: 'Иван', body: 'Отличный платок', rating: 5,
    reply: 'Спасибо за отзыв!', translations: {}, createdAt: D, publishedAt: D,
    ...over,
  };
}

describe('reviews/review-dto — toPublicReviewDto', () => {
  it('отдаёт только публичные поля, скрывает служебные', () => {
    const dto = toPublicReviewDto(row());
    expect(dto).toEqual({
      id: 'r1',
      authorName: 'Иван',
      rating: 5,
      body: 'Отличный платок',
      reply: 'Спасибо за отзыв!',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    // Убеждаемся, что нет утечки внутренних полей.
    expect('translations' in dto).toBe(false);
    expect('status' in dto).toBe(false);
  });

  it('локализует ТОЛЬКО reply по locale (en), body/author НЕ переводит', () => {
    const dto = toPublicReviewDto(
      row({ translations: { en: { reply: 'Thank you!' } } }),
      { locale: 'en', defaultLocale: 'ru' },
    );
    expect(dto.reply).toBe('Thank you!');
    // UGC остаётся на языке автора.
    expect(dto.body).toBe('Отличный платок');
    expect(dto.authorName).toBe('Иван');
  });

  it('нет перевода reply на locale → фолбэк на базовый (ru)', () => {
    const dto = toPublicReviewDto(row(), { locale: 'fr', defaultLocale: 'ru' });
    expect(dto.reply).toBe('Спасибо за отзыв!');
  });

  it('reply=null остаётся null', () => {
    const dto = toPublicReviewDto(row({ reply: null }));
    expect(dto.reply).toBeNull();
  });
});

describe('reviews/review-dto — toReviewAggregateDto', () => {
  it('округляет average до 1 знака и отдаёт распределение', () => {
    const agg: ReviewAggregate = {
      average: 4.333333,
      count: 3,
      distribution: { 1: 0, 2: 0, 3: 1, 4: 0, 5: 2 },
    };
    const dto = toReviewAggregateDto(agg);
    expect(dto.average).toBe(4.3);
    expect(dto.count).toBe(3);
    expect(dto.distribution['5']).toBe(2);
    expect(dto.distribution['3']).toBe(1);
  });

  it('пустой агрегат → average 0, count 0', () => {
    const dto = toReviewAggregateDto({
      average: 0,
      count: 0,
      distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    });
    expect(dto.average).toBe(0);
    expect(dto.count).toBe(0);
  });
});
