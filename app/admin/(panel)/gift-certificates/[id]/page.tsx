import Link from 'next/link';
import { getTranslations } from 'next-intl/server';

import { can } from '@/lib/auth/rbac';
import { getLocaleConfig } from '@/lib/i18n';
import { getGiftCertificateById, getRedemptions } from '@/lib/gift-certificates';
import { formatDateTime } from '@/lib/admin/order-format';

import { Forbidden } from '../../_components/Forbidden';
import { PageHeader } from '../../_components/PageHeader';
import { guardGift } from '../_components/guard';
import { GiftCertificateForm } from '../_components/GiftCertificateForm';

/**
 * Карточка подарочного сертификата (docs/24 §5): просмотр остатка + правка
 * (пополнение/срок/описание+переводы, gift.write) + история списаний (леджер).
 * Списание — только из чекаута (4b), здесь не вручную.
 *
 * Доступ: gift.read для чтения; форма правит под gift.write (без права — форма
 * доступна, но серверный гвард отклонит мутацию). force-dynamic.
 */
export const dynamic = 'force-dynamic';

/** Ключ подписи источника выпуска (issue_source, миграция 0054). */
function issueSourceKey(src: string | null): string {
  if (src === 'order') return 'giftCertificates.detailPage.issueSource.order';
  if (src === 'auto') return 'giftCertificates.detailPage.issueSource.auto';
  if (src === 'manual') return 'giftCertificates.detailPage.issueSource.manual';
  return 'giftCertificates.detailPage.issueSource.none';
}

export default async function EditGiftCertificatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations();
  const guard = await guardGift('gift.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission={t('giftCertificates.detailPage.moduleDisabled')} />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const [cert, localeConfig] = await Promise.all([getGiftCertificateById(id), getLocaleConfig()]);

  if (!cert) {
    return (
      <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-6">
        <h1 className="text-xl font-semibold text-amber-800">{t('giftCertificates.detailPage.notFound.title')}</h1>
        <p className="mt-2 text-sm text-amber-700">
          <Link href="/admin/gift-certificates" className="text-blue-700 hover:underline">
            {t('giftCertificates.detailPage.notFound.backLink')}
          </Link>
        </p>
      </div>
    );
  }

  const canWrite = can(guard.user, 'gift.write');
  const redemptions = await getRedemptions(id);

  return (
    <div className="max-w-3xl">
      <PageHeader
        title={t('giftCertificates.detailPage.title', { code: cert.code })}
        subtitle={t('giftCertificates.detailPage.subtitle', {
          remaining: cert.remaining,
          currency: cert.currency,
          initial: cert.initialAmount,
        })}
        breadcrumbs={[{ label: t('giftCertificates.detailPage.breadcrumb'), href: '/admin/gift-certificates' }, { label: cert.code }]}
        backHref="/admin/gift-certificates"
        backLabel={t('giftCertificates.detailPage.backLabel')}
      />

      {cert.issuedOrderId ? (
        <section className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm">
          <h2 className="font-semibold text-gray-900">{t('giftCertificates.detailPage.origin.title')}</h2>
          <p className="mt-1 text-gray-700">
            {t.rich('giftCertificates.detailPage.origin.text', {
              source: t(issueSourceKey(cert.issueSource)),
              orderId: cert.issuedOrderId.slice(0, 8),
              link: (chunks) => (
                <Link href={`/admin/orders/${cert.issuedOrderId}`} className="text-blue-700 hover:underline">
                  {chunks}
                </Link>
              ),
            })}
          </p>
        </section>
      ) : null}

      <div className="mt-6">
        <GiftCertificateForm
          cert={cert}
          locales={localeConfig.locales}
          defaultLocale={localeConfig.defaultLocale}
        />
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-gray-900">{t('giftCertificates.detailPage.redemptions.title')}</h2>
        {redemptions.length === 0 ? (
          <p className="mt-2 text-sm text-gray-600">{t('giftCertificates.detailPage.redemptions.empty')}</p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-gray-500">
                  <th className="px-4 py-2 font-medium">{t('giftCertificates.detailPage.redemptions.colDate')}</th>
                  <th className="px-4 py-2 font-medium">{t('giftCertificates.detailPage.redemptions.colOrder')}</th>
                  <th className="px-4 py-2 font-medium">{t('giftCertificates.detailPage.redemptions.colAmount')}</th>
                  <th className="px-4 py-2 font-medium">{t('giftCertificates.detailPage.redemptions.colState')}</th>
                </tr>
              </thead>
              <tbody>
                {redemptions.map((r) => (
                  <tr key={r.id} className="border-t border-gray-100">
                    <td className="whitespace-nowrap px-4 py-2 text-gray-600">{formatDateTime(r.createdAt)}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">
                      <Link href={`/admin/orders/${r.orderId}`} className="text-blue-700 hover:underline">
                        {r.orderId.slice(0, 8)}…
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-gray-900">{r.amount}</td>
                    <td className="px-4 py-2 text-gray-600">
                      {r.reversedAt
                        ? t('giftCertificates.detailPage.redemptions.reversed', { date: formatDateTime(r.reversedAt) })
                        : t('giftCertificates.detailPage.redemptions.redeemed')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
