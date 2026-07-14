'use server';

/**
 * Server Actions среза «Отзывы» (docs/24 §4) — АДМИН-модерация, прод-обёртки.
 *
 * Файл 'use server' экспортирует ТОЛЬКО async-функции. Фабрика (createReviewActions),
 * типы зависимостей (ReviewActionDeps), прод-зависимости (productionReviewDeps) и
 * вспомогательные не-async функции — в lib/reviews/action-factory.ts (эталон
 * lib/settings/action-factory). Здесь — лишь тонкие async-обёртки над прод-экземпляром.
 *
 * Submit с витрины идёт отдельным storefront-роутом, НЕ через эти actions.
 */

import { createReviewActions, productionReviewDeps } from './action-factory';

// Прод-инстанс (тонкие обёртки для form-actions).
const prodActions = createReviewActions(productionReviewDeps());
export const setReviewStatus = prodActions.setReviewStatus;
export const replyToReview = prodActions.replyToReview;
export const deleteReviewAction = prodActions.deleteReview;
