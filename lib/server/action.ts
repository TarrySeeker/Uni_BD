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
      /**
       * МАШИНОЧИТАЕМЫЙ код доменного отказа (OrderError.code / CatalogError.code
       * и т.п.), если ошибка его несёт. Поле ДОБАВОЧНОЕ и необязательное:
       * существующие потребители читают error/message как раньше.
       *
       * Зачем: без него UI различал бы отказы только по человеческому тексту.
       * Например, «Отгружен» может не пройти по двум совершенно разным причинам —
       * конкурентная смена статуса (conflict, надо просто обновить страницу) и
       * недоступный остаток (commit_failed, нужен осознанный форс). Панель
       * статусов предлагает выход только во втором случае — по коду, а не по
       * подстроке сообщения (которое ещё и переводится).
       */
      code?: string;
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
  /** Необязательные ICU-параметры для интерполяции перевода (t(message, params)). */
  readonly params?: Record<string, string | number>;

  constructor(message: string, params?: Record<string, string | number>) {
    super(message);
    this.name = 'PublicActionError';
    this.params = params;
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
  /**
   * Локализовать сообщение об ошибке в язык оператора админки (волна 6-Б, подход B).
   * Вход трактуется как i18n-КЛЮЧ: есть ключ в каталоге → перевод, иначе строка
   * возвращается КАК ЕСТЬ (безопасный фолбэк для ещё не переведённых сообщений).
   * Дефолт — next-intl getTranslations (translateMessage); в юнит-тестах
   * переопределяется. Необязательна: если не задана, defineAction берёт
   * translateMessage — существующие тесты с частичным набором deps не ломаются.
   */
  translate?: (
    key: string,
    params?: Record<string, string | number>,
  ) => Promise<string>;
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

/**
 * Перевод по умолчанию — next-intl getTranslations в языке оператора (cookie
 * NEXT_LOCALE → users.ui_locale, см. i18n/request.ts). Best-effort: вне
 * реквест-контекста или для несуществующего ключа возвращает вход БЕЗ изменений
 * — поэтому ещё не переведённые (сырые) сообщения показываются как прежде, и
 * пайплайн ничего не ломает при частичной миграции. next-intl/server
 * импортируется ДИНАМИЧЕСКИ — чтобы юнит-импорт action.ts не тянул серверный API.
 *
 * ЭКСПОРТИРУЕТСЯ: серверным обёрткам форм, которые отказывают ДО defineAction
 * (например «файл не выбран» при разборе FormData), нужен тот же переводчик —
 * иначе такие сообщения остаются на языке автора кода.
 */
export async function translateMessage(
  key: string,
  params?: Record<string, string | number>,
): Promise<string> {
  try {
    const { getTranslations } = await import('next-intl/server');
    const t = await getTranslations();
    return t.has(key) ? t(key, resolveParamKeys(t, params)) : key;
  } catch {
    return key;
  }
}

/**
 * Разворачивает ЗНАЧЕНИЯ ICU-параметров, которые сами являются ключами каталога.
 *
 * ЗАЧЕМ (аудит minor №7). Сообщение о конкурентной смене статуса подставляло СЫРОЙ
 * код: «переход из "awaiting_payment" более неактуален» — служебная строка вместо
 * человеческой подписи, да ещё и на языке автора кода. Подписи статусов живут в
 * lib/orders/labels (единый источник, G-15) и отдаются потребителям КЛЮЧОМ
 * каталога (orderStatusLabelKey и т.п.), потому что доменный слой не знает языка
 * оператора. ICU вложенных подстановок не умеет, поэтому разворачиваем ключи
 * здесь, ровно перед форматированием — и карты подписей нигде не дублируются.
 *
 * Строка-параметр, которой в каталоге НЕТ, остаётся как есть (обычные значения
 * вроде email или номера заказа не меняются). Числа не трогаем.
 */
function resolveParamKeys(
  t: { has: (key: string) => boolean; (key: string): string },
  params?: Record<string, string | number>,
): Record<string, string | number> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    out[name] = typeof value === 'string' && t.has(value) ? t(value) : value;
  }
  return out;
}

/**
 * Машиночитаемый код доменного отказа, если ошибка его несёт.
 *
 * Базовый PublicActionError поля `code` не имеет — его добавляют доменные
 * наследники (OrderError, CatalogError, …). Читаем структурно, чтобы ядро не
 * зависело от конкретных доменов.
 */
function domainCode(error: PublicActionError): string | undefined {
  const candidate = (error as unknown as { code?: unknown }).code;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Ошибки полей из issues Zod — по ПОЛНОМУ пути и по верхнему уровню сразу.
 *
 * ЗАЧЕМ (аудит 2026-07-26, находка №33). Раньше здесь стоял
 * `parsed.error.flatten().fieldErrors`, который раскладывает сообщения по ПЕРВОМУ
 * сегменту пути: ошибка `['delivery','address']` попадала под ключ 'delivery'.
 * Формы же читают ошибку по полному имени поля (`fe('delivery.address')`,
 * `fe('customer.email')`), поэтому под полем не появлялось НИЧЕГО, и точная
 * доменная фраза («Для курьерской доставки требуется адрес доставки.»)
 * подменялась общим «Проверьте корректность полей формы».
 *
 * Расширение АДДИТИВНОЕ: ключ верхнего уровня по-прежнему заполняется (формы,
 * читающие `fe('items')`, работают как раньше), рядом появляется полный
 * dotted-путь ('items.0.qty', 'delivery.pvzCode'). Ошибки уровня всей формы
 * (path=[]) в fieldErrors не попадают — как и прежде.
 */
function collectFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const push = (key: string, message: string): void => {
    const bucket = (out[key] ??= []);
    // Одно и то же сообщение не дублируем (полный путь и верхний уровень могут
    // совпасть, и одно поле может собрать несколько одинаковых issue).
    if (!bucket.includes(message)) {
      bucket.push(message);
    }
  };
  for (const issue of issues) {
    if (issue.path.length === 0) {
      continue;
    }
    const full = issue.path.map((seg) => String(seg)).join('.');
    push(full, issue.message);
    const top = String(issue.path[0]);
    if (top !== full) {
      push(top, issue.message);
    }
  }
  return out;
}

/** Набор зависимостей по умолчанию (продакшен-окружение). */
export const defaultDeps: ActionDeps = {
  getCurrentUser: defaultGetCurrentUser,
  writeAudit: defaultWriteAudit,
  revalidate: defaultRevalidate,
  getRequestMeta: defaultGetRequestMeta,
  translate: translateMessage,
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
  const translate = deps.translate ?? translateMessage;

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
      // Сообщения трактуются как i18n-ключи и локализуются в язык оператора
      // (подход B); не-ключи проходят как есть (безопасный фолбэк).
      const parsed = opts.input.safeParse(raw);
      if (!parsed.success) {
        const fieldErrors = collectFieldErrors(parsed.error.issues);
        const localized: Record<string, string[]> = {};
        for (const [field, msgs] of Object.entries(fieldErrors)) {
          localized[field] = await Promise.all(
            (msgs ?? []).map((m) => translate(m)),
          );
        }
        return { ok: false, error: 'validation', fieldErrors: localized };
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
        const message = await translate(error.message, error.params);
        const code = domainCode(error);
        return code
          ? { ok: false, error: 'validation', code, message }
          : { ok: false, error: 'validation', message };
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
