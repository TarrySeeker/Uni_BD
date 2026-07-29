import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NAV, buildAdminNav } from '@/lib/admin/nav';
import type { AuthUser } from '@/lib/auth/rbac';
import { ALL_PERMISSIONS } from '@/lib/auth/permissions';

/**
 * Раздел админки «Письма».
 *
 * Тестов React-компонентов в проекте нет (environment: 'node'), поэтому вёрстку и
 * проводку сторожим по исходнику — тот же приём, что в
 * tests/admin/operator-screens.guard.test.ts.
 *
 * Сторожим ПРИЧИНЫ, по которым раздел мог бы оказаться бесполезным:
 *   • владелец не видит, ушло письмо или нет (ради этого и заведён журнал);
 *   • кнопка «отправить повторно» есть, но не защищена правом;
 *   • страница показывает состояние SMTP, но раскрывает пароль;
 *   • раздел не попал в меню — значит, его никто не найдёт.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

/**
 * Исходник БЕЗ комментариев — для проверок вида «конструкции в коде НЕТ».
 * Объясняющий комментарий обязан называть снятый/делегированный приём, иначе
 * следующий читатель не поймёт гарда; за живой код такая цитата считаться не
 * должна (приём из tests/admin/operator-screens.guard.test.ts).
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PAGE = read('app/admin/(panel)/mail/page.tsx');
/**
 * Доменное действие живёт в lib/mail/actions.ts, а в _components лежит лишь
 * ТОНКАЯ серверная обёртка для импорта из 'use client' — это принятый в проекте
 * раскладка (образец: lib/newsletter/actions.ts + subscribers/_components/
 * subscriber-actions.ts). Гарды смотрят в оба файла по их назначению.
 */
const ACTIONS = read('lib/mail/actions.ts');
const ACTIONS_WRAPPER = read('app/admin/(panel)/mail/_components/mail-actions.ts');
const ROW = read('app/admin/(panel)/mail/_components/MailRowActions.tsx');

function user(permissions: string[]): AuthUser {
  return {
    id: 'u-1',
    email: 'op@example.test',
    isOwner: false,
    permissions: new Set(permissions) as AuthUser['permissions'],
  };
}

describe('админка: пункт меню «Письма»', () => {
  it('пункт есть в NAV и ведёт на /admin/mail', () => {
    const item = NAV.find((n) => n.href === '/admin/mail');
    expect(item, 'пункта «Письма» нет в меню — раздел никто не найдёт').toBeTruthy();
  });

  it('пункт локализуем (labelKey), а не только с русской подписью', () => {
    const item = NAV.find((n) => n.href === '/admin/mail')!;
    expect(item.labelKey).toBe('nav.mail');
    expect(item.label.length).toBeGreaterThan(0);
  });

  it('пункт закрыт правом (не виден оператору без него)', () => {
    const item = NAV.find((n) => n.href === '/admin/mail')!;
    expect(item.permission).toBeTruthy();
    const withPerm = buildAdminNav(user([item.permission!]), []);
    const without = buildAdminNav(user([]), []);
    expect(withPerm.some((n) => n.href === '/admin/mail')).toBe(true);
    expect(without.some((n) => n.href === '/admin/mail')).toBe(false);
  });

  it('право пункта существует в каталоге прав платформы', () => {
    const item = NAV.find((n) => n.href === '/admin/mail')!;
    expect(ALL_PERMISSIONS.some((p) => p.code === item.permission)).toBe(true);
  });

  it('раздел CORE (без module): письма относятся сразу к нескольким модулям', () => {
    // Письма шлют и заказы, и доставка, и сертификаты — прятать раздел за один
    // модуль означало бы терять журнал при его выключении.
    const item = NAV.find((n) => n.href === '/admin/mail')!;
    expect(item.module).toBeUndefined();
  });
});

describe('админка: страница «Письма»', () => {
  it('проверяет право на сервере, а не только прячет пункт меню', () => {
    expect(PAGE).toContain('requireUser');
    expect(PAGE).toContain('Forbidden');
  });

  it('читает журнал из репозитория почты (а не свой SQL в компоненте)', () => {
    expect(PAGE).toContain('listMailLog');
    expect(PAGE).toContain('countMailLog');
  });

  it('показывает статус отправки — иначе журнал бесполезен', () => {
    expect(PAGE).toMatch(/status/i);
  });

  it('время выводится в поясе магазина (аудит major №26 — один пояс на админку)', () => {
    expect(PAGE).toContain('getShopTimeZone');
    expect(PAGE).toContain('formatDateTime');
  });

  it('динамическая страница (читает БД и cookies)', () => {
    expect(PAGE).toContain("dynamic = 'force-dynamic'");
  });

  it('показывает состояние почты магазина (настроена / не настроена)', () => {
    // Без этого владелец не поймёт, почему все письма в статусе «пропущено».
    expect(PAGE).toMatch(/isMailConfigured|mailDisabledReason/);
  });

  it('🔴 страница НЕ выводит пароль/логин SMTP', () => {
    expect(PAGE).not.toMatch(/SMTP_PASSWORD|config\.password|config\.user/);
  });

  it('🔴 страница не выводит тела писем (их нет в журнале по построению)', () => {
    expect(PAGE).not.toMatch(/\.html\b|\.text\b/);
  });
});

describe('админка: повторная отправка', () => {
  it('действие идёт через defineAction (guard → Zod → БД → revalidate → audit)', () => {
    expect(ACTIONS).toContain('defineAction');
    expect(ACTIONS).toContain("'use server'");
  });

  it('обёртка для клиента — серверная и только проксирует (без своей логики)', () => {
    expect(ACTIONS_WRAPPER).toContain("'use server'");
    expect(ACTIONS_WRAPPER).toContain('resendMail');
    // Своих guard/Zod/SQL в обёртке быть не должно — иначе появится второй,
    // неизбежно расходящийся пайплайн проверок. Сверяем по КОДУ без
    // комментариев: доку обёртки положено ссылаться на defineAction словами.
    expect(stripComments(ACTIONS_WRAPPER)).not.toContain('defineAction');
    expect(ACTIONS_WRAPPER).not.toMatch(/\bsql`/);
  });

  it('повторная отправка требует права ЗАПИСИ, а не чтения', () => {
    expect(ACTIONS).toMatch(/permission:\s*'[a-z]+\.write'/);
  });

  it('действие пишет аудит (кто и когда переслал письмо)', () => {
    expect(ACTIONS).toContain('audit:');
  });

  it('действие зовёт общий resend, а не дублирует сборку письма', () => {
    expect(ACTIONS).toContain('resendMailById');
  });

  it('вход валидируется Zod (id письма — не произвольная строка)', () => {
    expect(ACTIONS).toMatch(/z\.(object|uuid|string)/);
  });

  it('🔴 действие не возвращает наружу тело письма и код сертификата', () => {
    expect(ACTIONS).not.toMatch(/\bhtml\b|\bcode\b/);
  });

  it('кнопка в UI — клиентский компонент с обработкой ошибки', () => {
    expect(ROW).toContain("'use client'");
    expect(ROW).toContain('resend');
    expect(ROW).toMatch(/error|Ошибк|role="alert"/);
  });
});

describe('🔴 SMTP-секреты не редактируются через админку', () => {
  it('в разделе настроек нет схемы с паролем SMTP (секреты живут в .env)', () => {
    const schemas = read('lib/settings/schemas.ts');
    expect(schemas).not.toMatch(/smtpPassword|SMTP_PASSWORD/i);
  });

  it('форма/страница писем не отправляет SMTP-настройки на сервер', () => {
    expect(ACTIONS).not.toMatch(/smtp/i);
  });
});
