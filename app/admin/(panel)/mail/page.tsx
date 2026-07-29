import { getTranslations } from 'next-intl/server';

import { formatDateTime } from '@/lib/admin/order-format';
import { getShopTimeZone } from '@/lib/admin/timezone';
import { listTruncationNotice } from '@/lib/admin/list-truncation';
import { can } from '@/lib/auth/rbac';
import { requireUser } from '@/lib/auth/session';
import { getMailConfig, isMailConfigured } from '@/lib/mail/config';
import { countMailLog, listMailLog } from '@/lib/mail/repository';

import { Forbidden } from '../_components/Forbidden';
import { PageHeader } from '../_components/PageHeader';
import { MailRowActions } from './_components/MailRowActions';
import { MailStatusBadge } from './_components/MailStatusBadge';

/**
 * Раздел «Письма» — журнал отправок почты покупателям.
 *
 * ЗАЧЕМ ВЛАДЕЛЬЦУ ЭТОТ ЭКРАН. Письмо с кодом подарочного сертификата — документ
 * на предъявителя. Без журнала спор «мне ничего не пришло» неразрешим: не видно
 * ни факта отправки, ни адреса, ни причины отказа, и нет способа переслать.
 * Раздел отвечает ровно на эти вопросы и даёт кнопку «отправить повторно».
 *
 * 🔴 ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: тела письма и кода сертификата. Их нет в журнале
 * по построению (см. шапку миграции 0061) — иначе экран, доступный любому
 * оператору с orders.read, показывал бы чужие деньги.
 *
 * 🔴 SMTP-СЕКРЕТЫ ЭКРАН НЕ ПОКАЗЫВАЕТ И НЕ РЕДАКТИРУЕТ. Он выводит лишь
 * СОСТОЯНИЕ («настроено / не настроено») и адрес отправителя. Пароль живёт в
 * .env инстанса — обоснование в шапке lib/mail/config.ts.
 *
 * Доступ — orders.read (как «Заявки» и «Подписчики»); пересылка — orders.write.
 * force-dynamic: читает БД и cookies.
 */
export const dynamic = 'force-dynamic';

/** Сколько писем показываем без пагинации; при превышении — плашка усечения. */
const LIST_LIMIT = 200;

export default async function MailPage() {
  const t = await getTranslations();
  // Пояс магазина — один на всю админку (аудит major №26).
  const timeZone = await getShopTimeZone();
  const user = await requireUser();
  if (!can(user, 'orders.read')) {
    return <Forbidden permission="orders.read" />;
  }

  const [entries, total] = await Promise.all([listMailLog(LIST_LIMIT), countMailLog()]);
  const truncation = listTruncationNotice(entries.length, total, LIST_LIMIT);

  // Состояние почты инстанса: без него владелец не поймёт, почему все письма
  // «пропущены» (типовой случай на стенде — SMTP просто не задан).
  const config = getMailConfig();
  const configured = isMailConfigured(config);

  // Пересылать письма может только тот, кому разрешена запись операционных данных.
  const canWrite = can(user, 'orders.write');

  return (
    <div className="max-w-5xl">
      <PageHeader
        title={t('nav.mail')}
        subtitle={t('mail.page.subtitle', { total })}
        breadcrumbs={[{ label: t('nav.mail') }]}
      />

      <p
        role="status"
        className={
          configured
            ? 'mt-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
            : 'mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800'
        }
      >
        {configured
          ? t('mail.page.enabled', { from: config.from ?? '' })
          : t('mail.page.disabled')}
      </p>

      {truncation ? (
        <p
          role="status"
          className="mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          {truncation}. {t('mail.page.truncationHint')}
        </p>
      ) : null}

      {entries.length === 0 ? (
        <p className="mt-6 text-sm text-gray-600">{t('mail.page.empty')}</p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-4 py-2 font-medium">{t('mail.page.columns.date')}</th>
                <th className="px-4 py-2 font-medium">{t('mail.page.columns.recipient')}</th>
                <th className="px-4 py-2 font-medium">{t('mail.page.columns.template')}</th>
                <th className="px-4 py-2 font-medium">{t('mail.page.columns.status')}</th>
                <th className="px-4 py-2 font-medium">{t('mail.page.columns.attempts')}</th>
                {canWrite ? (
                  <th className="px-4 py-2 text-right font-medium">{t('common.table.actions')}</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-t border-gray-100">
                  <td className="whitespace-nowrap px-4 py-2 text-gray-600">
                    {formatDateTime(entry.createdAt, timeZone)}
                  </td>
                  <td className="px-4 py-2">{entry.recipient}</td>
                  <td className="px-4 py-2">
                    {/*
                      Подпись шаблона — из каталога интерфейса по СТАБИЛЬНОМУ
                      идентификатору. Незнакомый шаблон (строка из старого релиза)
                      показывается как есть, а не пустой ячейкой.
                    */}
                    {t.has(`mail.template.${entry.template}`)
                      ? t(`mail.template.${entry.template}`)
                      : entry.template}
                  </td>
                  <td className="px-4 py-2">
                    <MailStatusBadge status={entry.status} error={entry.error} />
                  </td>
                  <td className="px-4 py-2 text-gray-600">{entry.attempts}</td>
                  {canWrite ? (
                    <td className="px-4 py-2 text-right">
                      <MailRowActions
                        id={entry.id}
                        recipient={entry.recipient}
                        resendable={Boolean(entry.orderId)}
                      />
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
