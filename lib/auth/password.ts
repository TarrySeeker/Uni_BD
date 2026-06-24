import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 экспортирует Algorithm/Version как ambient `const enum`,
// который недоступен под isolatedModules. Поэтому фиксируем числовые значения
// напрямую: Algorithm.Argon2id === 2, Version.V0x13 === 1.
const ALGORITHM_ARGON2ID = 2;
const VERSION_V0X13 = 1;

/**
 * Хеширование паролей (см. docs/04 §4.3, §4.4; ADR-006).
 *
 * Алгоритм — argon2id (гибрид, рекомендация OWASP: устойчив и к GPU-перебору,
 * и к side-channel). Хеш — самодостаточная PHC-строка ($argon2id$v=19$m=...,
 * t=...,p=...$<salt>$<hash>), соль и параметры лежат внутри строки, поэтому
 * отдельная колонка соли в users не нужна.
 */

/**
 * Прод-параметры argon2id, зафиксированы здесь (ориентир OWASP 2024 для
 * argon2id: m=19456 KiB, t=2, p=1). Подобраны как разумный баланс
 * «стойкость / время на целевом VPS». Менять — осознанно, т.к. рост
 * стоимости влияет на латентность логина.
 */
export const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  version: VERSION_V0X13,
  // 19456 KiB ≈ 19 MiB памяти на хеш.
  memoryCost: 19_456,
  // Число проходов (итераций).
  timeCost: 2,
  // Один поток — детерминированно и достаточно при m-hard параметрах.
  parallelism: 1,
} as const;

/**
 * Хеширует пароль argon2id и возвращает PHC-строку для users.password_hash.
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * Проверяет пароль против PHC-хеша.
 *
 * Параметры верификации читаются из самой PHC-строки, поэтому опции при
 * verify передавать не нужно (и не следует — иначе старые хеши с другими
 * параметрами перестанут проверяться). На некорректном/битом хеше argon2
 * бросает — мы это гасим и возвращаем false, чтобы вызывающий код не падал.
 */
export async function verifyPassword(
  hashStr: string,
  plain: string,
): Promise<boolean> {
  try {
    return await verify(hashStr, plain);
  } catch {
    return false;
  }
}

/**
 * Заранее заготовленный валидный argon2id-хеш случайной строки.
 *
 * Назначение — защита от timing-атак (§4.4): когда пользователь по email не
 * найден, вызывающий код всё равно выполняет verify против DUMMY_HASH, чтобы
 * время ответа не зависело от существования аккаунта. Это статическая
 * константа (сгенерирована заранее с прод-параметрами m=19456,t=2,p=1),
 * а не результат hash() на старте — так нет лишней работы при импорте модуля.
 */
export const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$BiR1M316pt5gGjF5+RJmjA$' +
  'wMTI3mXlfmcWtpT/aJqhKEB4wwjFmzqaAg/WrnZzGps';

/**
 * Всегда выполняет verify против DUMMY_HASH и всегда возвращает false.
 *
 * Используется в ветке «пользователь не найден» при логине, чтобы уравнять
 * время ответа с веткой существующего пользователя. Никогда не бросает.
 */
export async function verifyDummy(plain: string): Promise<boolean> {
  try {
    await verify(DUMMY_HASH, plain);
  } catch {
    // Игнорируем — задача только потратить сопоставимое время.
  }
  return false;
}
