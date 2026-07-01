/**
 * Статус-машина заявок (G-09) как ДАННЫЕ (whitelist переходов) + чистые функции.
 *
 * Образец — lib/orders/status.ts: единый источник истины переходов живёт здесь, а
 * не размазан по коду. UI рисует только разрешённые из текущего статуса переходы;
 * Server Action валидирует тот же whitelist через canLeadTransition. Все функции
 * чистые и тестируемые без БД.
 *
 * Статусы синхронизированы с CHECK таблицы leads (db/migrations/0030_leads.sql):
 *   new | in_progress | done | spam.
 *
 *   new ─► in_progress ─► done
 *    │           │
 *    └──► spam ◄─┘   (spam = «в архив/в спам»; обратимо → new для переоткрытия)
 *
 * Все статусы взаимно достижимы (владелец может вернуть заявку в работу или
 * переоткрыть из done/spam), но «нулевой» переход (из X в X) запрещён.
 */

/** Полный набор статусов заявки (= CHECK в БД). Единый источник истины. */
export const LEAD_STATUSES = ['new', 'in_progress', 'done', 'spam'] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Таблица допустимых переходов (whitelist). Ключ — «из», значение — список «в». */
export const LEAD_STATUS_TRANSITIONS: Readonly<
  Record<LeadStatus, readonly LeadStatus[]>
> = {
  new: ['in_progress', 'done', 'spam'],
  in_progress: ['done', 'spam', 'new'],
  done: ['in_progress', 'new', 'spam'],
  spam: ['new'],
};

/** Человекочитаемые подписи статусов (для бейджей/кнопок админки). */
export const LEAD_STATUS_LABELS: Readonly<Record<LeadStatus, string>> = {
  new: 'Новая',
  in_progress: 'В работе',
  done: 'Обработана',
  spam: 'В архиве',
};

/** True, если строка — известный статус заявки. */
export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

/** Подпись статуса (фолбэк — сама строка, если статус неизвестен). */
export function leadStatusLabel(status: string): string {
  return isLeadStatus(status) ? LEAD_STATUS_LABELS[status] : status;
}

/** Список статусов, в которые можно перейти из текущего (для кнопок UI). */
export function nextLeadStatuses(from: string): LeadStatus[] {
  if (!isLeadStatus(from)) return [];
  return [...LEAD_STATUS_TRANSITIONS[from]];
}

/** True, если переход from→to разрешён whitelist'ом (X→X запрещён). */
export function canLeadTransition(from: string, to: string): boolean {
  if (!isLeadStatus(from) || !isLeadStatus(to)) return false;
  return LEAD_STATUS_TRANSITIONS[from].includes(to);
}
