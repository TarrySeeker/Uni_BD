/**
 * Server Actions обработки заявок (G-09): смена статуса и удаление.
 *
 * Раньше раздел /admin/leads был «тупиком владельца» — заявки висели в статусе
 * 'new' навсегда (аудит, kind=dead-button). Теперь владелец меняет статус и
 * удаляет заявки из таблицы.
 *
 * Все мутации — через единый пайплайн defineAction (lib/server/action, §4.7):
 * guard (orders.write) → Zod → handler (проверка перехода whitelist'ом →
 * запись в БД) → revalidate('/admin/leads') → audit ('lead.status.change' /
 * 'lead.delete'). Право orders.write — то же, под которым работает раздел
 * (guardLeads читает orders.read; смежная смежная запись — orders.write).
 *
 * ТЕСТИРУЕМОСТЬ без БД/Next (как createSettingsActions): createLeadActions(deps)
 * инъецирует репозиторий и зависимости пайплайна (ActionDeps). Прод-обёртки
 * (actions-prod) вызывают её с productionLeadDeps().
 */

import {
  defineAction,
  defaultDeps,
  PublicActionError,
  type ActionDeps,
  type ActionCtx,
} from '@/lib/server/action';

import { LeadStatusInputSchema, LeadIdInputSchema, LeadAnswerInputSchema } from './schemas';
import { canLeadTransition, leadStatusLabel } from './status';
import {
  getLeadStatus as dbGetLeadStatus,
  updateLeadStatus as dbUpdateLeadStatus,
  updateLeadAnswer as dbUpdateLeadAnswer,
  deleteLead as dbDeleteLead,
} from './repository';

/** Путь раздела заявок для инвалидации после мутации. */
const LEADS_PATH = '/admin/leads';
/** Дашборд показывает счётчик новых заявок — инвалидируем его тоже. */
const ADMIN_HOME = '/admin';

/** Зависимости фабрики lead-actions (инъекция для тестов без БД). */
export interface LeadActionDeps {
  /** Зависимости пайплайна defineAction (user/audit/revalidate/meta). */
  actionDeps: ActionDeps;
  /** Текущий статус заявки (null — не найдена). */
  getLeadStatus: (id: string) => Promise<string | null>;
  /** Смена статуса; true — строка найдена и обновлена. */
  updateLeadStatus: (id: string, status: string) => Promise<boolean>;
  /** Запись ответа оператора (§9); true — строка найдена и обновлена. */
  updateLeadAnswer: (id: string, answer: string | null) => Promise<boolean>;
  /** Удаление; true — строка существовала. */
  deleteLead: (id: string) => Promise<boolean>;
}

/** Прод-зависимости (реальная БД + дефолтный пайплайн). */
export function productionLeadDeps(): LeadActionDeps {
  return {
    actionDeps: defaultDeps,
    getLeadStatus: dbGetLeadStatus,
    updateLeadStatus: dbUpdateLeadStatus,
    updateLeadAnswer: dbUpdateLeadAnswer,
    deleteLead: dbDeleteLead,
  };
}

/**
 * Собирает набор lead-actions поверх инъецированных зависимостей.
 * Прод-обёртки вызывают её с productionLeadDeps().
 */
export function createLeadActions(deps: LeadActionDeps) {
  const { actionDeps } = deps;

  /**
   * Смена статуса заявки. Целевой статус провалидирован Zod-enum; переход из
   * текущего статуса проверяется whitelist'ом (canLeadTransition) — анти-tamper
   * и защита от «нулевого» перехода. Заявка обязана существовать.
   */
  const setLeadStatus = defineAction({
    permission: 'orders.write',
    input: LeadStatusInputSchema,
    deps: actionDeps,
    handler: async (data, _ctx: ActionCtx) => {
      const current = await deps.getLeadStatus(data.id);
      if (current === null) {
        throw new PublicActionError('Заявка не найдена.');
      }
      if (!canLeadTransition(current, data.status)) {
        throw new PublicActionError(
          `Недопустимый переход статуса заявки: «${leadStatusLabel(current)}» → «${leadStatusLabel(data.status)}».`,
        );
      }

      const updated = await deps.updateLeadStatus(data.id, data.status);
      if (!updated) {
        // Гонка: заявку удалили между чтением и записью.
        throw new PublicActionError('Заявка не найдена.');
      }

      return {
        result: { id: data.id, status: data.status },
        revalidate: [LEADS_PATH, ADMIN_HOME],
        audit: {
          action: 'lead.status.change',
          entityType: 'lead',
          entityId: data.id,
          before: { status: current },
          after: { status: data.status },
        },
      };
    },
  });

  /**
   * Запись ответа оператора на заявку (§9). Ответ провалидирован Zod (длина);
   * пустой (после trim) снимает ответ (NULL). Заявка обязана существовать.
   * Право orders.write — то же, под которым идут прочие мутации раздела.
   */
  const answerLead = defineAction({
    permission: 'orders.write',
    input: LeadAnswerInputSchema,
    deps: actionDeps,
    handler: async (data, _ctx: ActionCtx) => {
      const current = await deps.getLeadStatus(data.id);
      if (current === null) {
        throw new PublicActionError('Заявка не найдена.');
      }
      const updated = await deps.updateLeadAnswer(data.id, data.answer);
      if (!updated) {
        throw new PublicActionError('Заявка не найдена.');
      }
      return {
        result: { id: data.id },
        revalidate: [LEADS_PATH],
        audit: {
          action: 'lead.answer',
          entityType: 'lead',
          entityId: data.id,
          after: { answered: data.answer.trim() !== '' },
        },
      };
    },
  });

  /** Удаление заявки (необратимо). Заявка обязана существовать. */
  const deleteLead = defineAction({
    permission: 'orders.write',
    input: LeadIdInputSchema,
    deps: actionDeps,
    handler: async (data, _ctx: ActionCtx) => {
      const before = await deps.getLeadStatus(data.id);
      const deleted = await deps.deleteLead(data.id);
      if (!deleted) {
        throw new PublicActionError('Заявка не найдена.');
      }
      return {
        result: { id: data.id },
        revalidate: [LEADS_PATH, ADMIN_HOME],
        audit: {
          action: 'lead.delete',
          entityType: 'lead',
          entityId: data.id,
          before: before !== null ? { status: before } : undefined,
        },
      };
    },
  });

  return { setLeadStatus, answerLead, deleteLead };
}
