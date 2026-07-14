/**
 * Хеширование паролей покупателя (docs/24 §6).
 *
 * ЕДИНЫЙ ИСТОЧНИК: argon2id-примитивы переиспользуются из admin-контура
 * (@/lib/auth/password) — они провайдеро-нейтральны (хеш/верификация пароля,
 * DUMMY_HASH для timing-защиты). Это НЕ смешивает контуры: admin и покупатель
 * держат СВОИ таблицы/сессии/куки; общей остаётся только математика argon2id
 * (дублировать параметры/DUMMY_HASH было бы источником рассинхрона).
 *
 * Параметры — прод-профиль OWASP 2024 (m=19456 KiB, t=2, p=1), см. lib/auth/password.
 */

export {
  hashPassword,
  verifyPassword,
  verifyDummy,
  ARGON2_OPTIONS,
} from '@/lib/auth/password';
