import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  verifyDummy,
  DUMMY_HASH,
} from '@/lib/auth/password';

// argon2id — память-hard и намеренно медленный алгоритм, поэтому даём
// тестам запас по времени. Прод-параметры (см. password.ts) специально
// тяжёлые; тесты используют их же, чтобы проверять реальный код.
const TIMEOUT = 15_000;

describe('auth/password', () => {
  it(
    'hashPassword выдаёт PHC-строку argon2id',
    async () => {
      const hash = await hashPassword('correct horse battery staple');
      expect(hash).toMatch(/^\$argon2id\$/);
    },
    TIMEOUT,
  );

  it(
    'один пароль даёт разные хеши (разные соли)',
    async () => {
      const a = await hashPassword('one-password');
      const b = await hashPassword('one-password');
      expect(a).not.toBe(b);
    },
    TIMEOUT,
  );

  it(
    'verifyPassword === true для правильного пароля',
    async () => {
      const hash = await hashPassword('s3cr3t-pass');
      await expect(verifyPassword(hash, 's3cr3t-pass')).resolves.toBe(true);
    },
    TIMEOUT,
  );

  it(
    'verifyPassword === false для неправильного пароля',
    async () => {
      const hash = await hashPassword('s3cr3t-pass');
      await expect(verifyPassword(hash, 'wrong-pass')).resolves.toBe(false);
    },
    TIMEOUT,
  );

  it(
    'verifyPassword === false для битого хеша (без throw)',
    async () => {
      await expect(verifyPassword('не-валидный-хеш', 'whatever')).resolves.toBe(
        false,
      );
      await expect(verifyPassword('', 'whatever')).resolves.toBe(false);
    },
    TIMEOUT,
  );

  it(
    'DUMMY_HASH — валидный argon2id-хеш',
    async () => {
      expect(DUMMY_HASH).toMatch(/^\$argon2id\$/);
    },
    TIMEOUT,
  );

  it(
    'verifyDummy всегда возвращает false и не бросает',
    async () => {
      await expect(verifyDummy('любой-ввод')).resolves.toBe(false);
      await expect(verifyDummy('')).resolves.toBe(false);
    },
    TIMEOUT,
  );
});
