/**
 * POST /api/storefront/v1/account/verify/resend — повторная отправка письма с
 * подтверждением адреса.
 *
 * Требует входа — и это не формальность. Роут отправляет письмо на адрес, а
 * значит без проверки сессии превращался бы в средство рассылки на чужие адреса
 * от имени магазина. Адрес берётся из сессии, а не из тела запроса: указать
 * чужой невозможно.
 *
 * Выпуск нового токена гасит предыдущий (см. репозиторий): если покупатель
 * запросил письмо повторно, старая ссылка обязана перестать работать.
 */

import { runStorefront, jsonData, handlePreflight } from '@/lib/storefront/response';
import { issueEmailVerification } from '@/lib/customer/service';
import { ACCOUNT_METHODS, requireCustomer } from '@/lib/customer/route-helpers';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req: Request): Promise<Response> {
  return handlePreflight(req, ACCOUNT_METHODS);
}

export async function POST(req: Request): Promise<Response> {
  return runStorefront(
    req,
    async ({ cors }) => {
      const who = await requireCustomer(req, cors);
      if (who instanceof Response) return who;

      // Уже подтверждён — молча отвечаем успехом. Отдельная ошибка тут не нужна:
      // для покупателя итог тот же, а лишняя ветка только путает.
      if (!who.emailVerified) {
        await issueEmailVerification(who.id, who.email);
      }

      return jsonData(
        { ok: true, message: 'Если адрес ещё не подтверждён, письмо отправлено повторно.' },
        {},
        cors,
      );
    },
    { module: 'account', methods: ACCOUNT_METHODS },
  );
}
