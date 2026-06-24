/**
 * Единый структурированный логгер приложения (Этап 6, пакет 6.3, §6.3.1; ADR-015 §6.3).
 *
 * Модель:
 *   * Каждое событие — ОДНА JSON-строка в stdout: `{ts, level, msg, ...context}`.
 *     stdout собирается Docker logging-драйвером (json-file с ротацией, см. compose).
 *   * Уровни debug < info < warn < error; фильтрация по LOG_LEVEL (дефолт info).
 *   * Секреты НЕ логируются — переиспользуем санитайзер аудита (lib/audit/log.ts),
 *     единый allow/deny-list. Ни одно поле password/token/secret/… не утекает.
 *   * `child(context)` создаёт логгер с прибинденным контекстом (module/requestId/…),
 *     который добавляется ко всем событиям. Поля события переопределяют контекст.
 *   * LOG_PRETTY=true → человекочитаемый вывод (dev). В prod — чистый JSON.
 *
 * Это НЕ server-action-модуль ('use server' отсутствует) — обычный модуль с
 * чистой функцией форматирования `formatLine` (для тестируемости) поверх sink.
 */

import { sanitizeValue } from '@/lib/audit/sanitize';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Числовой ранг уровней для сравнения с порогом. */
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const VALID_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Произвольный контекст события: сериализуемые поля. */
export type LogContext = Record<string, unknown>;

/** Данные для форматирования одной строки лога. */
export interface LogEvent {
  level: LogLevel;
  msg: string;
  context?: LogContext;
}

export interface FormatOptions {
  /** Человекочитаемый вывод вместо JSON (LOG_PRETTY). */
  pretty: boolean;
}

/**
 * Чистая функция форматирования одного события в строку.
 * Контекст санитизируется (секреты вырезаются) ТЕМ ЖЕ санитайзером, что и аудит.
 * Поля {ts, level, msg} имеют приоритет — контекст не может их перезаписать.
 */
export function formatLine(event: LogEvent, opts: FormatOptions): string {
  const ts = new Date().toISOString();
  // Санитизируем контекст рекурсивно (тот же allow/deny-list, что у аудита).
  const safeContext =
    (sanitizeValue(event.context ?? {}) as LogContext) ?? {};

  if (opts.pretty) {
    // Человекочитаемая ветка (dev): «<ts> <LEVEL> msg {context}».
    const ctxKeys = Object.keys(safeContext);
    const ctxStr = ctxKeys.length > 0 ? ` ${JSON.stringify(safeContext)}` : '';
    return `${ts} ${event.level.toUpperCase()} ${event.msg}${ctxStr}`;
  }

  // Базовые поля идут первыми; context не может затереть ts/level/msg.
  const record: Record<string, unknown> = {
    ...safeContext,
    ts,
    level: event.level,
    msg: event.msg,
  };
  return JSON.stringify(record);
}

/** Публичный интерфейс логгера. */
export interface Logger {
  debug(msg: string, context?: LogContext): void;
  info(msg: string, context?: LogContext): void;
  warn(msg: string, context?: LogContext): void;
  error(msg: string, context?: LogContext): void;
  /** Создаёт дочерний логгер с прибинденным контекстом (не мутирует родителя). */
  child(context: LogContext): Logger;
}

export interface CreateLoggerOptions {
  /** Источник конфигурации (для тестов); по умолчанию process.env. */
  env?: Record<string, string | undefined>;
  /** Куда писать строку (для тестов); по умолчанию console.log. */
  sink?: (line: string) => void;
  /** Базовый контекст (используется child). */
  baseContext?: LogContext;
}

/** Нормализует LOG_LEVEL из env в валидный уровень (дефолт info). */
function resolveLevel(raw: string | undefined): LogLevel {
  const value = (raw ?? '').toLowerCase();
  return (VALID_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : 'info';
}

/** Нормализует LOG_PRETTY из env в boolean. */
function resolvePretty(raw: string | undefined): boolean {
  const value = (raw ?? '').toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * Создаёт логгер. Конфигурация (LOG_LEVEL/LOG_PRETTY) читается из env один раз
 * при создании. В проде используется дефолтный инстанс `logger` ниже.
 */
export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const env = opts.env ?? process.env;
  const sink = opts.sink ?? ((line: string) => console.log(line));
  const threshold = LEVEL_RANK[resolveLevel(env.LOG_LEVEL)];
  const pretty = resolvePretty(env.LOG_PRETTY);
  const baseContext = opts.baseContext ?? {};

  function emit(level: LogLevel, msg: string, context?: LogContext): void {
    if (LEVEL_RANK[level] < threshold) {
      return; // ниже порога — не пишем.
    }
    // Контекст события переопределяет базовый (child) контекст.
    const merged: LogContext = { ...baseContext, ...(context ?? {}) };
    sink(formatLine({ level, msg, context: merged }, { pretty }));
  }

  const logger: Logger = {
    debug: (msg, context) => emit('debug', msg, context),
    info: (msg, context) => emit('info', msg, context),
    warn: (msg, context) => emit('warn', msg, context),
    error: (msg, context) => emit('error', msg, context),
    child: (context) =>
      createLogger({
        env,
        sink,
        baseContext: { ...baseContext, ...context },
      }),
  };

  return logger;
}

/**
 * Дефолтный инстанс приложения. Конфигурация из process.env.
 * Используйте `logger.child({ module })` в точках интеграции.
 */
export const logger: Logger = createLogger();
