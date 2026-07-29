import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMailSender, type MailSenderDeps } from '@/lib/mail/sender';
import type { MailConfig, MailMessage, MailLogEntry } from '@/lib/mail/types';

/**
 * Слой отправки: транспорт + журнал + ретраи.
 *
 * 🔴 ДВА ИНВАРИАНТА, РАДИ КОТОРЫХ ВСЁ НАПИСАНО:
 *   1. sendMail НИКОГДА не бросает — он живёт в денежном пути (после фиксации
 *      оплаты). Сбой почты обязан стать failed-записью журнала, а не исключением,
 *      которое откатит заказ или заставит эквайер ретраить вебхук.
 *   2. SMTP не настроен → отправка «выключена»: запись журнала со статусом
 *      skipped + строка в лог, ноль обращений к сети, ноль исключений.
 *
 * Реальный SMTP не дёргается нигде: транспорт инъецируется.
 */

const CONFIG_ON: MailConfig = {
  enabled: true,
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'shop@example.test',
  password: 'secret',
  from: 'shop@example.test',
  fromName: 'Магазин',
  timeoutMs: 10_000,
};

const CONFIG_OFF: MailConfig = {
  ...CONFIG_ON,
  enabled: false,
  host: null,
  user: null,
  password: null,
};

const MESSAGE: MailMessage = {
  to: 'ivan@example.test',
  subject: 'Ваш заказ 2026-000123',
  html: '<p>Спасибо!</p>',
  text: 'Спасибо!',
  template: 'order_confirmation',
  locale: 'ru',
  orderId: 'ord-1',
};

interface Harness {
  deps: MailSenderDeps;
  sendCalls: unknown[][];
  journal: MailLogEntry[];
  logs: { level: string; msg: string; ctx?: Record<string, unknown> }[];
}

function harness(
  config: MailConfig,
  transportBehavior: (attempt: number) => Promise<{ messageId: string }>,
  overrides: Partial<MailSenderDeps> = {},
): Harness {
  const sendCalls: unknown[][] = [];
  const journal: MailLogEntry[] = [];
  const logs: Harness['logs'] = [];
  let attempt = 0;
  let seq = 0;

  const deps: MailSenderDeps = {
    config,
    transport: {
      send: async (...args: unknown[]) => {
        sendCalls.push(args);
        attempt += 1;
        return transportBehavior(attempt);
      },
    },
    journal: {
      create: async (input) => {
        seq += 1;
        const entry: MailLogEntry = {
          id: `log-${seq}`,
          recipient: input.recipient,
          template: input.template,
          locale: input.locale,
          status: input.status,
          attempts: input.attempts ?? 0,
          error: input.error ?? null,
          orderId: input.orderId ?? null,
          subject: input.subject ?? null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          sentAt: null,
        };
        journal.push(entry);
        return entry;
      },
      markSent: async (id, attempts) => {
        const e = journal.find((j) => j.id === id);
        if (e) {
          e.status = 'sent';
          e.attempts = attempts;
          e.sentAt = new Date(0);
        }
        return e ?? null;
      },
      markFailed: async (id, attempts, error) => {
        const e = journal.find((j) => j.id === id);
        if (e) {
          e.status = 'failed';
          e.attempts = attempts;
          e.error = error;
        }
        return e ?? null;
      },
    },
    logger: {
      debug: (msg, ctx) => logs.push({ level: 'debug', msg, ctx }),
      info: (msg, ctx) => logs.push({ level: 'info', msg, ctx }),
      warn: (msg, ctx) => logs.push({ level: 'warn', msg, ctx }),
      error: (msg, ctx) => logs.push({ level: 'error', msg, ctx }),
      child: () => deps.logger,
    },
    sleep: async () => {},
    ...overrides,
  };
  return { deps, sendCalls, journal, logs };
}

const OK = async () => ({ messageId: 'mid-1' });
const ALWAYS_FAIL = async () => {
  throw new Error('ECONNREFUSED smtp.example.test:587');
};

describe('mail/sender — успешная отправка', () => {
  it('письмо уходит в транспорт, журнал получает статус sent', async () => {
    const h = harness(CONFIG_ON, OK);
    const res = await createMailSender(h.deps).sendMail(MESSAGE);

    expect(res.status).toBe('sent');
    expect(res.attempts).toBe(1);
    expect(h.sendCalls).toHaveLength(1);
    expect(h.journal).toHaveLength(1);
    expect(h.journal[0]!.status).toBe('sent');
    expect(h.journal[0]!.recipient).toBe('ivan@example.test');
    expect(h.journal[0]!.template).toBe('order_confirmation');
  });

  it('в транспорт уезжают from/to/subject/html/text', async () => {
    const h = harness(CONFIG_ON, OK);
    await createMailSender(h.deps).sendMail(MESSAGE);
    const payload = h.sendCalls[0]![0] as Record<string, unknown>;
    expect(payload.to).toBe('ivan@example.test');
    expect(payload.subject).toBe('Ваш заказ 2026-000123');
    expect(payload.html).toBe('<p>Спасибо!</p>');
    expect(payload.text).toBe('Спасибо!');
    expect(String(payload.from)).toContain('shop@example.test');
    expect(String(payload.from)).toContain('Магазин');
  });

  it('без MAIL_FROM_NAME отправитель — голый адрес', async () => {
    const h = harness({ ...CONFIG_ON, fromName: null }, OK);
    await createMailSender(h.deps).sendMail(MESSAGE);
    const payload = h.sendCalls[0]![0] as Record<string, unknown>;
    expect(payload.from).toBe('shop@example.test');
  });
});

describe('mail/sender — режим «почта не настроена»', () => {
  it('SMTP не настроен → skipped, транспорт НЕ дёргается, исключения нет', async () => {
    const h = harness(CONFIG_OFF, ALWAYS_FAIL);
    const res = await createMailSender(h.deps).sendMail(MESSAGE);

    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('mail_disabled');
    expect(h.sendCalls).toHaveLength(0);
  });

  it('факт «письмо не отправлено» виден в журнале и в логе (а не теряется)', async () => {
    const h = harness(CONFIG_OFF, ALWAYS_FAIL);
    await createMailSender(h.deps).sendMail(MESSAGE);

    expect(h.journal).toHaveLength(1);
    expect(h.journal[0]!.status).toBe('skipped');
    expect(h.logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('выключенная почта НЕ является ошибкой для вызывающего (заказ живёт дальше)', async () => {
    const h = harness(CONFIG_OFF, ALWAYS_FAIL);
    const res = await createMailSender(h.deps).sendMail(MESSAGE);
    expect(res.ok).toBe(true);
  });
});

describe('mail/sender — ретраи и отказы', () => {
  it('транзиентный сбой → повтор; второй попытки достаточно', async () => {
    let n = 0;
    const h = harness(CONFIG_ON, async () => {
      n += 1;
      if (n === 1) throw new Error('ETIMEDOUT');
      return { messageId: 'mid-2' };
    });
    const res = await createMailSender(h.deps).sendMail(MESSAGE);

    expect(res.status).toBe('sent');
    expect(res.attempts).toBe(2);
    expect(h.journal[0]!.status).toBe('sent');
    expect(h.journal[0]!.attempts).toBe(2);
  });

  it('исчерпание попыток → failed в журнале, но НЕ исключение', async () => {
    const h = harness(CONFIG_ON, ALWAYS_FAIL);
    const res = await createMailSender(h.deps).sendMail(MESSAGE);

    expect(res.status).toBe('failed');
    expect(res.ok).toBe(false);
    expect(h.journal[0]!.status).toBe('failed');
    expect(h.journal[0]!.attempts).toBeGreaterThan(1);
    expect(h.journal[0]!.error).toContain('ECONNREFUSED');
  });

  it('между попытками выдерживается пауза (не долбим релей в цикле)', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const h = harness(CONFIG_ON, ALWAYS_FAIL, { sleep });
    await createMailSender(h.deps).sendMail(MESSAGE);
    expect(sleep).toHaveBeenCalled();
    // Пауза растёт (backoff), а не остаётся нулевой.
    const delays = sleep.mock.calls.map(([ms]) => ms);
    expect(delays.every((d) => d > 0)).toBe(true);
  });

  it('падение САМОГО журнала не роняет отправку (журнал — не денежный путь)', async () => {
    const h = harness(CONFIG_ON, OK, {
      journal: {
        create: async () => {
          throw new Error('БД недоступна');
        },
        markSent: async () => null,
        markFailed: async () => null,
      },
    });
    const res = await createMailSender(h.deps).sendMail(MESSAGE);
    // Письмо всё равно отправлено; отсутствие записи журнала залогировано.
    expect(res.status).toBe('sent');
    expect(h.sendCalls).toHaveLength(1);
    expect(h.logs.some((l) => l.level === 'error' || l.level === 'warn')).toBe(true);
  });

  it('невалидный адрес получателя → skipped без обращения к сети', async () => {
    const h = harness(CONFIG_ON, ALWAYS_FAIL);
    const res = await createMailSender(h.deps).sendMail({ ...MESSAGE, to: 'не-адрес' });
    expect(res.status).toBe('skipped');
    expect(res.reason).toBe('invalid_recipient');
    expect(h.sendCalls).toHaveLength(0);
  });

  it('пустой адрес получателя → skipped (заказ мог быть оформлен без email)', async () => {
    const h = harness(CONFIG_ON, ALWAYS_FAIL);
    const res = await createMailSender(h.deps).sendMail({ ...MESSAGE, to: '' });
    expect(res.status).toBe('skipped');
    expect(h.sendCalls).toHaveLength(0);
  });
});

describe('mail/sender — БЕЗОПАСНОСТЬ', () => {
  const GIFT: MailMessage = {
    to: 'ivan@example.test',
    subject: 'Ваш подарочный сертификат',
    html: '<p>Код: SECRET-CODE-42</p>',
    text: 'Код: SECRET-CODE-42',
    template: 'gift_certificate',
    locale: 'ru',
    orderId: 'ord-1',
  };

  it('🔴 тело письма (и код сертификата в нём) НЕ попадает в журнал', async () => {
    const h = harness(CONFIG_ON, OK);
    await createMailSender(h.deps).sendMail(GIFT);

    const serialized = JSON.stringify(h.journal);
    expect(serialized).not.toContain('SECRET-CODE-42');
    // В журнале — только факт и адресат.
    expect(h.journal[0]!.recipient).toBe('ivan@example.test');
    expect(h.journal[0]!.template).toBe('gift_certificate');
  });

  it('🔴 тело письма НЕ попадает в логи ни при успехе, ни при провале', async () => {
    const okH = harness(CONFIG_ON, OK);
    await createMailSender(okH.deps).sendMail(GIFT);
    expect(JSON.stringify(okH.logs)).not.toContain('SECRET-CODE-42');

    const failH = harness(CONFIG_ON, ALWAYS_FAIL);
    await createMailSender(failH.deps).sendMail(GIFT);
    expect(JSON.stringify(failH.logs)).not.toContain('SECRET-CODE-42');
  });

  it('пароль SMTP не утекает в логи', async () => {
    const h = harness(CONFIG_ON, ALWAYS_FAIL);
    await createMailSender(h.deps).sendMail(GIFT);
    expect(JSON.stringify(h.logs)).not.toContain('secret');
  });

  /**
   * Инъекцию заголовков делает именно ПЕРЕВОД СТРОКИ: `Заказ\r\nBcc: …` —
   * это две строки заголовков. Схлопнув CR/LF в пробел, мы обезвреживаем атаку
   * полностью: `Bcc:` остаётся безобидным ТЕКСТОМ внутри одной темы. Требовать
   * вырезания самой подстроки «Bcc:» не нужно и вредно — тогда пришлось бы
   * вести чёрный список имён заголовков, который всегда неполон.
   */
  it('CRLF в теме схлопывается перед отправкой (инъекция SMTP-заголовков)', async () => {
    const h = harness(CONFIG_ON, OK);
    await createMailSender(h.deps).sendMail({
      ...MESSAGE,
      subject: 'Заказ\r\nBcc: attacker@evil.test',
    });
    const payload = h.sendCalls[0]![0] as Record<string, unknown>;
    expect(String(payload.subject)).not.toMatch(/[\r\n]/);
    // Тема осталась ОДНОЙ строкой — второго заголовка не появилось.
    expect(String(payload.subject).split(/\r?\n/)).toHaveLength(1);
  });

  it('CRLF в адресе получателя отвергается (инъекция заголовков)', async () => {
    const h = harness(CONFIG_ON, OK);
    const res = await createMailSender(h.deps).sendMail({
      ...MESSAGE,
      to: 'ivan@example.test\r\nBcc: attacker@evil.test',
    });
    expect(res.status).toBe('skipped');
    expect(h.sendCalls).toHaveLength(0);
  });
});

describe('mail/sender — повторная отправка из админки', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resend пишет НОВУЮ запись журнала, а не переписывает историю', async () => {
    const h = harness(CONFIG_ON, OK);
    const sender = createMailSender(h.deps);
    await sender.sendMail(MESSAGE);
    await sender.sendMail(MESSAGE);
    expect(h.journal).toHaveLength(2);
    expect(h.journal.every((j) => j.status === 'sent')).toBe(true);
  });
});
