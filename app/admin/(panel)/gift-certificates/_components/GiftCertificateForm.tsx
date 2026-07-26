'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';

import type { GiftCertificate } from '@/lib/gift-certificates';
import type { ActionResult } from '@/lib/server/action';
import {
  LocaleTabs,
  toTranslationsState,
  translationsPayload,
  type TranslatableFieldDef,
  type TranslationsState,
} from '../../_components/LocaleTabs';

import { issueGiftCertificateAction, updateGiftCertificateAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';

type Fail = Extract<ActionResult<unknown>, { ok: false }>;

const inputCls = 'mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm';

/** ISO-строка validUntil → значение для <input type="datetime-local"> (локальное, без TZ). */
function toLocalInput(d: Date | null): string {
  if (!d) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Форма выпуска (create) и редактирования (edit) подарочного сертификата (docs/24 §5).
 *
 * create: code + name + номинал + срок + описание/условия (+переводы).
 * edit:   code read-only (неизменяем); номинал — ТОЛЬКО пополнение (вверх); показывает
 *         остаток/потрачено; правит срок/описание/условия/переводы.
 *
 * Мутации — issue/update Server Actions (gift.write на сервере). Переводы
 * description/terms — блок translations (LocaleTabs), база ru — в обычных полях.
 */
export function GiftCertificateForm({
  cert,
  locales,
  defaultLocale,
}: {
  /** null — режим выпуска; иначе — редактирование. */
  cert: GiftCertificate | null;
  locales: readonly string[];
  defaultLocale: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const isEdit = cert !== null;

  /** Переводимые поля сертификата для панели переводов (совпадает с GIFT_TR_FIELDS). */
  const GIFT_TR_FIELD_DEFS: readonly TranslatableFieldDef[] = [
    { key: 'description', labelKey: 'fields.description', kind: 'textarea' },
    { key: 'terms', labelKey: 'giftCertificates.giftCertificateForm.termsLabel', kind: 'textarea' },
  ];

  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [code, setCode] = useState(cert?.code ?? '');
  const [name, setName] = useState(cert?.name ?? '');
  const [initialAmount, setInitialAmount] = useState(cert?.initialAmount ?? '');
  const [validUntil, setValidUntil] = useState(toLocalInput(cert?.validUntil ?? null));
  const [description, setDescription] = useState(cert?.description ?? '');
  const [terms, setTerms] = useState(cert?.terms ?? '');
  const [comment, setComment] = useState(cert?.comment ?? '');
  // Стороны сделки (ТЗ п.7): «кто купил» / «на чьё имя» — снимки, не ссылки.
  const [purchaserName, setPurchaserName] = useState(cert?.purchaser.name ?? '');
  const [purchaserEmail, setPurchaserEmail] = useState(cert?.purchaser.email ?? '');
  const [purchaserPhone, setPurchaserPhone] = useState(cert?.purchaser.phone ?? '');
  const [recipientName, setRecipientName] = useState(cert?.recipient.name ?? '');
  const [recipientEmail, setRecipientEmail] = useState(cert?.recipient.email ?? '');
  const [recipientPhone, setRecipientPhone] = useState(cert?.recipient.phone ?? '');
  const [translations, setTranslations] = useState<TranslationsState>(
    toTranslationsState(cert?.translations),
  );

  function fe(f: string) {
    return fieldError(error, f);
  }

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);

    const validUntilIso = validUntil ? new Date(validUntil).toISOString() : null;
    const trPayload = translationsPayload(translations);
    const purchaser = { name: purchaserName, email: purchaserEmail, phone: purchaserPhone };
    const recipient = { name: recipientName, email: recipientEmail, phone: recipientPhone };

    let result: ActionResult<{ id: string }>;
    if (isEdit) {
      result = await updateGiftCertificateAction({
        id: cert!.id,
        name,
        initialAmount: initialAmount || undefined,
        validUntil: validUntilIso,
        description: description.trim() === '' ? null : description,
        terms: terms.trim() === '' ? null : terms,
        comment,
        translations: trPayload,
        purchaser,
        recipient,
      });
    } else {
      result = await issueGiftCertificateAction({
        code,
        name,
        initialAmount,
        validUntil: validUntilIso,
        description: description.trim() === '' ? null : description,
        terms: terms.trim() === '' ? null : terms,
        comment,
        translations: trPayload,
        purchaser,
        recipient,
      });
    }

    setPending(false);
    if (result.ok) {
      if (isEdit) {
        setSuccess(t('giftCertificates.giftCertificateForm.savedChanges'));
        router.refresh();
      } else {
        router.push('/admin/gift-certificates');
      }
    } else {
      setError(result);
    }
  }

  const canSubmit = isEdit ? name !== undefined : code.trim() !== '' && initialAmount.trim() !== '';

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error, t)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      {isEdit ? (
        <dl className="mb-6 grid grid-cols-2 gap-4 rounded-lg border border-gray-200 bg-gray-50 p-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-gray-500">{t('giftCertificates.giftCertificateForm.summary.nominal')}</dt>
            <dd className="font-medium text-gray-900">{cert!.initialAmount} {cert!.currency}</dd>
          </div>
          <div>
            <dt className="text-gray-500">{t('giftCertificates.giftCertificateForm.summary.spent')}</dt>
            <dd className="font-medium text-gray-900">{cert!.spentTotal} {cert!.currency}</dd>
          </div>
          <div>
            <dt className="text-gray-500">{t('giftCertificates.giftCertificateForm.summary.remaining')}</dt>
            <dd className="font-medium text-gray-900">{cert!.remaining} {cert!.currency}</dd>
          </div>
          <div>
            <dt className="text-gray-500">{t('giftCertificates.giftCertificateForm.summary.status')}</dt>
            <dd className="font-medium text-gray-900">{cert!.status}</dd>
          </div>
        </dl>
      ) : null}

      <LocaleTabs
        locales={locales}
        defaultLocale={defaultLocale}
        fields={GIFT_TR_FIELD_DEFS}
        value={translations}
        onChange={setTranslations}
        mode={isEdit ? 'edit' : 'create'}
        supportsCreateTranslations
        pending={pending}
        onSave={save}
      >
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label htmlFor="g-code" className="block text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.codeLabel')}</label>
            <input
              id="g-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              disabled={isEdit}
              placeholder={t('giftCertificates.giftCertificateForm.codePlaceholder')}
              className={`${inputCls} disabled:bg-gray-100`}
              required
            />
            {isEdit ? <p className="mt-1 text-xs text-gray-500">{t('giftCertificates.giftCertificateForm.codeLocked')}</p> : null}
            {fe('code') ? <p className="mt-1 text-xs text-red-600">{fe('code')}</p> : null}
          </div>

          <div>
            <label htmlFor="g-name" className="block text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.nameLabel')}</label>
            <input
              id="g-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('giftCertificates.giftCertificateForm.namePlaceholder')}
              className={inputCls}
            />
          </div>

          <div>
            <label htmlFor="g-face" className="block text-sm font-medium text-gray-700">
              {isEdit
                ? t('giftCertificates.giftCertificateForm.faceTopUp')
                : t('giftCertificates.giftCertificateForm.faceRequired')}
            </label>
            <input
              id="g-face"
              value={initialAmount}
              onChange={(e) => setInitialAmount(e.target.value)}
              inputMode="decimal"
              placeholder={t('giftCertificates.giftCertificateForm.facePlaceholder')}
              className={inputCls}
              required={!isEdit}
            />
            {isEdit ? (
              <p className="mt-1 text-xs text-gray-500">
                {t('giftCertificates.giftCertificateForm.faceTopUpHelp')}
              </p>
            ) : null}
            {fe('initialAmount') ? <p className="mt-1 text-xs text-red-600">{fe('initialAmount')}</p> : null}
          </div>

          <div>
            <label htmlFor="g-valid" className="block text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.validUntilLabel')}</label>
            <input
              id="g-valid"
              type="datetime-local"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className={inputCls}
            />
            <p className="mt-1 text-xs text-gray-500">{t('giftCertificates.giftCertificateForm.validUntilHelp')}</p>
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="g-desc" className="block text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.descriptionLabel')}</label>
            <textarea
              id="g-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={inputCls}
            />
          </div>

          <div className="lg:col-span-2">
            <label htmlFor="g-terms" className="block text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.termsLabel')}</label>
            <textarea
              id="g-terms"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={3}
              className={inputCls}
            />
          </div>

          <fieldset className="lg:col-span-2 rounded border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.purchaserLegend')}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="g-buyer-name" className="block text-xs text-gray-500">{t('fields.name')}</label>
                <input id="g-buyer-name" value={purchaserName} onChange={(e) => setPurchaserName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor="g-buyer-email" className="block text-xs text-gray-500">{t('giftCertificates.giftCertificateForm.emailLabel')}</label>
                <input id="g-buyer-email" value={purchaserEmail} onChange={(e) => setPurchaserEmail(e.target.value)} className={inputCls} />
                {fe('purchaser.email') ? <p className="mt-1 text-xs text-red-600">{fe('purchaser.email')}</p> : null}
              </div>
              <div>
                <label htmlFor="g-buyer-phone" className="block text-xs text-gray-500">{t('giftCertificates.giftCertificateForm.phoneLabel')}</label>
                <input id="g-buyer-phone" value={purchaserPhone} onChange={(e) => setPurchaserPhone(e.target.value)} className={inputCls} />
              </div>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              {t('giftCertificates.giftCertificateForm.purchaserSnapshotHelp')}
            </p>
          </fieldset>

          <fieldset className="lg:col-span-2 rounded border border-gray-200 p-4">
            <legend className="px-1 text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.recipientLegend')}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="g-rcpt-name" className="block text-xs text-gray-500">{t('fields.name')}</label>
                <input id="g-rcpt-name" value={recipientName} onChange={(e) => setRecipientName(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label htmlFor="g-rcpt-email" className="block text-xs text-gray-500">{t('giftCertificates.giftCertificateForm.emailLabel')}</label>
                <input id="g-rcpt-email" value={recipientEmail} onChange={(e) => setRecipientEmail(e.target.value)} className={inputCls} />
                {fe('recipient.email') ? <p className="mt-1 text-xs text-red-600">{fe('recipient.email')}</p> : null}
              </div>
              <div>
                <label htmlFor="g-rcpt-phone" className="block text-xs text-gray-500">{t('giftCertificates.giftCertificateForm.phoneLabel')}</label>
                <input id="g-rcpt-phone" value={recipientPhone} onChange={(e) => setRecipientPhone(e.target.value)} className={inputCls} />
              </div>
            </div>
          </fieldset>

          <div className="lg:col-span-2">
            <label htmlFor="g-comment" className="block text-sm font-medium text-gray-700">{t('giftCertificates.giftCertificateForm.commentLabel')}</label>
            <input id="g-comment" value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} />
          </div>
        </div>

        <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
          <button
            type="button"
            onClick={save}
            disabled={pending || !canSubmit}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {pending
              ? t('common.form.saving')
              : isEdit
                ? t('common.actions.save')
                : t('giftCertificates.giftCertificateForm.submitIssue')}
          </button>
          <button
            type="button"
            onClick={() => router.push('/admin/gift-certificates')}
            className="text-sm text-gray-600 hover:underline"
          >
            {t('common.actions.cancel')}
          </button>
        </div>
      </LocaleTabs>
    </div>
  );
}
