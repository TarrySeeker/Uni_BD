/**
 * Машина статусов новости как ДАННЫЕ (docs/24 §3). Разрешённые переходы:
 *   draft   → published | archived
 *   published → draft | archived        (снятие с публикации / архивирование)
 *   archived  → draft                    (возврат в работу)
 * X → X запрещён (нет «переходов в себя»). Чистый модуль — тестируется без БД.
 */

import type { NewsStatus } from './types';

/** Карта допустимых переходов статуса новости. */
const TRANSITIONS: Record<NewsStatus, readonly NewsStatus[]> = {
  draft: ['published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
};

/** true, если переход from→to допустим машиной статусов. */
export function canTransitionNews(from: NewsStatus, to: NewsStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Список статусов, в которые можно перейти из текущего (для UI-кнопок). */
export function nextNewsStatuses(from: NewsStatus): readonly NewsStatus[] {
  return TRANSITIONS[from] ?? [];
}
