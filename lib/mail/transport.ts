/**
 * SMTP-транспорт поверх nodemailer.
 *
 * ВЫНЕСЕН В ОТДЕЛЬНЫЙ ФАЙЛ НАМЕРЕННО — это единственное место модуля, которое
 * знает про nodemailer и умеет ходить в сеть. Остальной код (sender/шаблоны/
 * уведомления) работает через порт MailTransport и потому тестируется без сети
 * и без единого обращения к настоящему релею.
 *
 * ЛЕНИВЫЙ ИМПОРТ nodemailer (`await import`) — по тем же причинам, что и ленивый
 * клиент БД (lib/db/client.ts): модуль импортируется из вебхуков и Server
 * Actions, а тянуть SMTP-библиотеку в бандл каждой такой точки на этапе сборки
 * незачем; в магазине без почты она не понадобится вовсе.
 *
 * СОЕДИНЕНИЕ НЕ КЕШИРУЕТСЯ ПУЛОМ: письма платформы редки (оплата заказа, смена
 * статуса), а долгоживущий SMTP-коннект в serverless/перезапускаемом контейнере
 * чаще ломается по таймауту релея, чем экономит рукопожатие. Транспорт создаётся
 * один на процесс и переиспользуется nodemailer'ом как обычное соединение.
 */

import { isPlausibleEmail } from './config';
import type { MailConfig, MailTransport } from './types';

/** Минимальная форма клиента nodemailer, которой мы пользуемся. */
interface NodemailerLike {
  sendMail(options: Record<string, unknown>): Promise<{ messageId?: string }>;
}

/**
 * Собирает заголовок From: `"Имя" <адрес>` либо голый адрес.
 *
 * Имя оборачивается в кавычки и очищается от кавычек/переводов строки: имя
 * магазина задаёт владелец в настройках, а CR/LF в заголовке — инъекция
 * SMTP-заголовков (см. ту же защиту для темы в templates.ts).
 */
export function formatFrom(config: MailConfig): string {
  const address = config.from ?? '';
  const name = config.fromName?.replace(/["\r\n]+/g, ' ').trim();
  return name ? `"${name}" <${address}>` : address;
}

let cachedClient: NodemailerLike | undefined;

/** Создаёт (или возвращает созданный) клиент nodemailer по конфигурации. */
async function getClient(config: MailConfig): Promise<NodemailerLike> {
  if (cachedClient) return cachedClient;

  const nodemailer = await import('nodemailer');
  const create = (nodemailer as unknown as { createTransport: (o: unknown) => NodemailerLike })
    .createTransport
    ? (nodemailer as unknown as { createTransport: (o: unknown) => NodemailerLike })
    : ((nodemailer as unknown as { default: { createTransport: (o: unknown) => NodemailerLike } })
        .default);

  cachedClient = create.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Аутентификация опциональна: релей внутри периметра часто принимает без неё.
    auth: config.user ? { user: config.user, pass: config.password ?? '' } : undefined,
    // Три таймаута вместо одного: релей может принять TCP и «замолчать» на
    // рукопожатии или на DATA. Без каждого из них письмо висит до таймаута ОС.
    connectionTimeout: config.timeoutMs,
    greetingTimeout: config.timeoutMs,
    socketTimeout: config.timeoutMs,
  });
  return cachedClient;
}

/** Сбрасывает кеш клиента (тесты/смена конфигурации). */
export function resetMailTransportCache(): void {
  cachedClient = undefined;
}

/**
 * Прод-транспорт. Бросает при отказе релея — ретраи и журнал живут уровнем выше
 * (lib/mail/sender.ts), чтобы политика повторов была одна на все транспорты.
 */
export function createSmtpTransport(config: MailConfig): MailTransport {
  return {
    async send(payload) {
      if (!config.enabled || !isPlausibleEmail(config.from)) {
        // Досюда дойти не должно (sender проверяет раньше), но транспорт обязан
        // отказать явно, а не молча «отправить» письмо в никуда.
        throw new Error('mail_transport_not_configured');
      }
      const client = await getClient(config);
      const info = await client.sendMail({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      });
      return { messageId: info.messageId ?? '' };
    },
  };
}
