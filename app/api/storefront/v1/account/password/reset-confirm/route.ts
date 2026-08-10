/**
 * POST /api/storefront/v1/account/password/reset-confirm — установка нового
 * пароля по ссылке из письма.
 *
 * Новая сессия здесь НЕ выдаётся намеренно: человек в кабинет ещё не входил, а
 * ссылка могла попасть к кому угодно — например, остаться в открытом почтовом
 * ящике. Пусть войдёт новым паролем; заодно это подтверждает, что пароль он
 * действительно запомнил.
 *
 * Все прежние сессии при этом закрываются: если восстановление понадобилось
 * из-за утечки, сессия злоумышленника не должна пережить смену пароля.
 */

import { runStorefront, jsonData, jsonError, handlePreflight } from '@/lib/storefront/response';
import { PasswordResetConfirmSchema } from '@/lib/customer/schemas';
import { confirmPasswordReset } from '@/lib/customer/service';
import { ACCOUNT_METHODS, sessionMeta } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      let body: unknown = null;
      try {
        body = await req.json();
      } catch {
        body = null;
      }

      const parsed = PasswordResetConfirmSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(
          'unprocessable',
          'Проверьте поля: новый пароль должен быть не короче 8 символов.',
          cors,
        );
      }

      const res = await confirmPasswordReset(
        parsed.data.token,
        parsed.data.newPassword,
        sessionMeta(req),
      );

      if (!res.ok) {
        // Просроченная, уже использованная и выдуманная ссылка неразличимы:
        // иначе перебор токенов получал бы обратную связь.
        return jsonError(
          'unauthorized',
          'Ссылка недействительна или устарела. Запросите восстановление пароля заново.',
          cors,
        );
      }

      return jsonData(
        { ok: true, message: 'Пароль изменён. Войдите с новым паролем.' },
        {},
        cors,
      );
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
