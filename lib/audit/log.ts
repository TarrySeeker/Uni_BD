import type { JSONValue } from 'postgres';
import { sql } from '@/lib/db/client';
import { sanitize, sanitizeValue, isSensitiveKey } from './sanitize';

// Санитизация вынесена в lib/audit/sanitize.ts (переиспользуется логгером без
// связности с этим модулем). Реэкспорт сохраняет публичный API audit/log.
export { sanitize, sanitizeValue, isSensitiveKey };

/**
 * Единый helper записи в audit_log (§7.2).
 *
 * Принципы (docs/04, §2.4 / §7):
 *   * Append-only: только INSERT (роль admik_app лишена UPDATE/DELETE на audit_log).
 *   * before/after пишутся как jsonb-снимки изменённых полей.
 *   * Санитизация: чувствительные поля (пароли, хеши, токены, секреты) НИКОГДА не
 *     попадают в журнал — вырезаются `sanitize` рекурсивно перед записью.
 *   * Аудит не должен ронять бизнес-операцию: ошибки записи логируются в console.error
 *     и НЕ пробрасываются наружу (мутация уже совершена, журнал — побочный эффект).
 */

export interface AuditEntry {
  /** Семантический код действия, например 'user.update', 'auth.login'. */
  action: string;
  /** Тип затронутой сущности: 'user', 'role', 'order', ... */
  entityType?: string;
  /** Идентификатор затронутой сущности (text — универсально для uuid/bigint). */
  entityId?: string;
  /** Состояние ДО изменения (NULL для create). */
  before?: Record<string, unknown>;
  /** Состояние ПОСЛЕ изменения (NULL для delete). */
  after?: Record<string, unknown>;
}

export interface AuditContext {
  /** Кто инициатор (NULL = система/аноним). */
  actorUserId?: string;
  /** Денормализованный email на момент действия (переживает удаление учётки). */
  actorEmail?: string;
  /** IP инициатора. */
  ip?: string;
  /** User-Agent инициатора. */
  userAgent?: string;
}

/**
 * Записывает событие в audit_log (§7.2). Параметризовано через tagged template `sql`.
 * before/after санитизируются и сериализуются в jsonb.
 *
 * Никогда не бросает наружу: сбой записи аудита логируется, но не прерывает
 * вызывающую бизнес-операцию.
 */
export async function writeAudit(entry: AuditEntry, ctx: AuditContext): Promise<void> {
  try {
    const before = sanitize(entry.before);
    const after = sanitize(entry.after);

    await sql`
      INSERT INTO audit_log
        (actor_user_id, actor_email, action, entity_type, entity_id,
         before_data, after_data, ip, user_agent)
      VALUES (
        ${ctx.actorUserId ?? null},
        ${ctx.actorEmail ?? null},
        ${entry.action},
        ${entry.entityType ?? null},
        ${entry.entityId ?? null},
        ${before === null ? null : sql.json(before as JSONValue)},
        ${after === null ? null : sql.json(after as JSONValue)},
        ${ctx.ip ?? null},
        ${ctx.userAgent ?? null}
      )
    `;
  } catch (error) {
    // Аудит — побочный эффект мутации; его сбой не должен ронять бизнес-операцию.
    console.error('[audit] не удалось записать событие аудита:', error);
  }
}
