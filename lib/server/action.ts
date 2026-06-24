import type { ZodType } from 'zod';

import { getCurrentUser as defaultGetCurrentUser } from '@/lib/auth/session';
import {
  requirePermission,
  ForbiddenError,
  type AuthUser,
} from '@/lib/auth/rbac';
import type { PermissionCode } from '@/lib/auth/permissions';
import {
  writeAudit as defaultWriteAudit,
  type AuditEntry,
} from '@/lib/audit/log';
import { logger } from '@/lib/logger';
import { normalizeClientIp } from '@/lib/server/request-ip';

/** Структурный логгер для наблюдаемости Server Actions (Этап 6, §6.3.1). */
const actionLog = logger.child({ module: 'action' });

/**
 * Унифицированный паттерн Server Action (docs/04 §4.7, ADR-002).
 *
 * Единая обёртка для всех мутаций: `guard → Zod → БД → инвалидация → audit`.
 * Гарантирует, что КАЖДАЯ мутация проходит один и тот же серверный пайплайн:
 *   1) аутентификация (getCurrentUser); нет пользователя → 'unauthorized';
 *   2) авторизация (requirePermission), если задано требуемое право → 'forbidden';
 *   3) валидация входа Zod (safeParse) → структурированные fieldErrors → 'validation';
 *   4) бизнес-handler (доступ к БД — внутри handler, параметризовано);
 *   5) инвалидация затронутых путей (revalidatePath);
 *   6) аудит (writeAudit) с actor/ip/ua из контекста — частью пайплайна, не «по желанию».
 *
 * ТЕСТИРУЕМОСТЬ без Next/БД (§4.7): серверные зависимости вынесены в объект `deps`
 * с дефолтами и переопределяемы в юнит-тестах. Серверный API next/cache и
 * получение IP/UA из next/headers импортируются ДИНАМИЧЕСКИ внутри функций —
 * чтобы импорт этого модуля из юнит-окружения не тянул серверные API.
 */

// -----------------------------------------------------------------------------
// Контракт типов (§4.7).
// -----------------------------------------------------------------------------

/** Контекст выполнения действия: кто инициатор и метаданные запроса. */
export interface ActionCtx {
  user: AuthUser;
  ip: string;
  userAgent?: string;
}

/** Машиночитаемые коды отказа пайплайна. */
export type ActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'internal';

/**
 * Результат действия — дискриминированное объединение по полю `ok`.
 * Успех несёт типизированные данные `O`; отказ несёт код ошибки и
 * (для валидации) пофайловые ошибки формы.
 */
export type ActionResult<O> =
  | { ok: true; data: O }
  | {
      ok: false;
      error: ActionError;
      fieldErrors?: Record<string, string[]>;
      message?: string;
    };

/** Что возвращает бизнес-handler: результат + опц. аудит + опц. инвалидация. */
export interface ActionHandlerOutput<O> {
  result: O;
  audit?: AuditEntry;
  revalidate?: string[];
}

/** Метаданные запроса (IP/UA) — для контекста и аудита. */
export interface RequestMeta {
  ip: string;
  userAgent?: string;
}

/**
 * Доменная ошибка с ПУБЛИЧНЫМ сообщением для пользователя.
 *
 * Обычные исключения handler'а маппятся в `error:'internal'` без текста (детали
 * не утекают наружу). Но некоторые бизнес-отказы должны показываться владельцу
 * понятной фразой («Пользователь с таким email уже существует», «Владельца
 * нельзя отключать»). Handler бросает этот класс — пайплайн маппит его в
 * `{ ok:false, error:'validation', message }`, и форма показывает `message`
 * (через action-result.errorMessage). Сообщение должно быть безопасным для UI
 * (без секретов/внутренних деталей).
 */
export class PublicActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublicActionError';
    Object.setPrototypeOf(this, PublicActionError.prototype);
  }
}

/**
 * Внешние зависимости пайплайна. Дефолты ссылаются на реальные серверные
 * модули; в юнит-тестах подменяются на моки (см. tests/server/action.test.ts).
 */
export interface ActionDeps {
  /** Получить текущего пользователя из сессии (cookie). */
  getCurrentUser: () => Promise<AuthUser | null>;
  /** Записать событие аудита. */
  writeAudit: (
    entry: AuditEntry,
    ctx: {
      actorUserId?: string;
      actorEmail?: string;
      ip?: string;
      userAgent?: string;
    },
  ) => Promise<void>;
  /** Инвалидировать путь (next/cache revalidatePath). */
  revalidate: (path: string) => Promise<void> | void;
  /** Извлечь IP/UA текущего запроса (next/headers). */
  getRequestMeta: () => Promise<RequestMeta>;
}

// -----------------------------------------------------------------------------
// Дефолтные зависимости. Серверные API импортируются ДИНАМИЧЕСКИ — чтобы импорт
// этого модуля в юнит-окружении не тянул next/cache и next/headers.
// -----------------------------------------------------------------------------

/** Заголовок прокси для реального клиентского IP (если приложение за прокси). */
const FORWARDED_FOR_HEADER = 'x-forwarded-for';
/** Запасной заголовок реального IP. */
const REAL_IP_HEADER = 'x-real-ip';

/** revalidatePath по умолчанию — динамический импорт next/cache. */
async function defaultRevalidate(path: string): Promise<void> {
  const { revalidatePath } = await import('next/cache');
  revalidatePath(path);
}

/**
 * IP/UA по умолчанию — читаются из заголовков запроса через next/headers.
 *
 * IP из X-Forwarded-For / X-Real-IP ВАЛИДИРУЕТСЯ (normalizeClientIp): заголовки
 * подконтрольны клиенту/прокси, а значение уходит в колонку `inet` (audit_log.ip).
 * Сырой мусор без валидации ломал бы каст к inet при записи аудита. Невалидный
 * IP → '' (пайплайн коалесцирует пустую строку в undefined → БД пишет null).
 */
async function defaultGetRequestMeta(): Promise<RequestMeta> {
  const { headers } = await import('next/headers');
  const store = await headers();
  const ip =
    normalizeClientIp(
      store.get(FORWARDED_FOR_HEADER),
      store.get(REAL_IP_HEADER),
    ) ?? '';
  const userAgent = store.get('user-agent') ?? undefined;
  return { ip, userAgent };
}

/** Набор зависимостей по умолчанию (продакшен-окружение). */
export const defaultDeps: ActionDeps = {
  getCurrentUser: defaultGetCurrentUser,
  writeAudit: defaultWriteAudit,
  revalidate: defaultRevalidate,
  getRequestMeta: defaultGetRequestMeta,
};

// -----------------------------------------------------------------------------
// defineAction — фабрика обёрнутого Server Action.
// -----------------------------------------------------------------------------

/** Опции определения действия. */
export interface DefineActionOptions<I, O> {
  /** Требуемое право (guard). Если не задано — проверяется только аутентификация. */
  permission?: PermissionCode;
  /** Zod-схема валидации входа. */
  input: ZodType<I>;
  /**
   * Бизнес-обработчик: получает провалидированные данные и контекст,
   * возвращает результат + опц. аудит + опц. список путей для инвалидации.
   */
  handler: (data: I, ctx: ActionCtx) => Promise<ActionHandlerOutput<O>>;
  /**
   * Переопределение зависимостей (для тестов). В проде не задаётся —
   * используются `defaultDeps`. Указанные поля сливаются с дефолтами.
   */
  deps?: Partial<ActionDeps>;
}

/**
 * Определяет Server Action по унифицированному паттерну (§4.7).
 *
 * @returns функцию `(raw: unknown) => Promise<ActionResult<O>>`, пригодную для
 *   прямого вызова из формы. Любая неожиданная ошибка маппится в
 *   `{ ok:false, error:'internal' }` (детали — в console.error, не наружу).
 */
export function defineAction<I, O>(
  opts: DefineActionOptions<I, O>,
): (raw: unknown) => Promise<ActionResult<O>> {
  const deps: ActionDeps = { ...defaultDeps, ...opts.deps };

  return async function action(raw: unknown): Promise<ActionResult<O>> {
    try {
      // (1) guard — аутентификация.
      const user = await deps.getCurrentUser();
      if (!user) {
        return { ok: false, error: 'unauthorized' };
      }

      // (2) guard — авторизация по праву (если требуется).
      if (opts.permission) {
        try {
          requirePermission(user, opts.permission);
        } catch (error) {
          if (error instanceof ForbiddenError) {
            return { ok: false, error: 'forbidden' };
          }
          throw error;
        }
      }

      // (3) Zod — валидация входа. Ошибка → структурированные fieldErrors.
      const parsed = opts.input.safeParse(raw);
      if (!parsed.success) {
        const { fieldErrors } = parsed.error.flatten();
        return {
          ok: false,
          error: 'validation',
          fieldErrors: fieldErrors as Record<string, string[]>,
        };
      }

      // Контекст: IP/UA текущего запроса + пользователь.
      const meta = await deps.getRequestMeta();
      const ctx: ActionCtx = {
        user,
        ip: meta.ip,
        userAgent: meta.userAgent,
      };

      // (4) БД — бизнес-handler (доступ к БД внутри handler, параметризовано).
      const output = await opts.handler(parsed.data, ctx);

      // (5) инвалидация — revalidatePath для каждого затронутого пути.
      if (output.revalidate && output.revalidate.length > 0) {
        for (const path of output.revalidate) {
          await deps.revalidate(path);
        }
      }

      // (6) audit — запись события с actor/ip/ua из контекста.
      if (output.audit) {
        await deps.writeAudit(output.audit, {
          actorUserId: user.id,
          actorEmail: user.email,
          ip: ctx.ip || undefined,
          userAgent: ctx.userAgent,
        });
      }

      // (7) успех.
      return { ok: true, data: output.result };
    } catch (error) {
      // Доменный отказ с публичным сообщением → отдаём текст пользователю.
      // Это НЕ «внутренняя» ошибка: бизнес-правило сознательно отклонило ввод
      // (дубликат email, защита владельца и т.п.), сообщение безопасно для UI.
      if (error instanceof PublicActionError) {
        return { ok: false, error: 'validation', message: error.message };
      }
      // Любая неожиданная ошибка → 'internal'; детали только в лог сервера.
      // Структурный JSON-лог (наблюдаемость, §6.3): permission/action — контекст,
      // текст ошибки — без секретов (санитизатор логгера вырежет чувствительное).
      actionLog.error('неожиданная ошибка в Server Action', {
        permission: opts.permission,
        err: error instanceof Error ? error.message : String(error),
      });
      console.error('[action] неожиданная ошибка в Server Action:', error);
      return { ok: false, error: 'internal' };
    }
  };
}
