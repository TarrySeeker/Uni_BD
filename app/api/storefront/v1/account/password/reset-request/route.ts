/**
 * POST /api/storefront/v1/account/password/reset-request — запрос ссылки
 * восстановления пароля.
 *
 * 🔴 Ответ ВСЕГДА одинаков — и для зарегистрированного адреса, и для чужого, и
 * для несуществующего. Разный ответ здесь превратил бы форму «забыли пароль» в
 * простейший способ выяснить, есть ли такой клиент в магазине.
 *
 * По той же причине ответ не зависит и от того, удалось ли отправить письмо: при
 * ненастроенной почте покупатель увидит то же сообщение, а администратор — запись
 * в журнале. Сообщать «письмо не отправлено» значило бы раскрывать состояние
 * инфраструктуры магазина посторонним.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { PasswordResetRequestSchema } from '@/lib/customer/schemas';
import { requestPasswordReset } from '@/lib/customer/service';
import { ACCOUNT_METHODS, sessionMeta } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

/** Единственный ответ этого роута — независимо от того, что произошло внутри. */
const NEUTRAL_MESSAGE =
  'Если аккаунт с таким адресом существует, мы отправили на него ссылку для восстановления пароля.';

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

      const parsed = PasswordResetRequestSchema.safeParse(body);
      // Даже невалидный адрес получает тот же ответ: иначе по коду ответа можно
      // было бы отличить «не наш формат» от «нет такого клиента».
      if (parsed.success) {
        await requestPasswordReset(parsed.data.email, sessionMeta(req));
      }

      return jsonData({ ok: true, message: NEUTRAL_MESSAGE }, {}, cors);
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
