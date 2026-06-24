'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { updateLegalContactsAction } from './form-actions';
import { errorMessage, fieldError } from './action-result';

/**
 * Форма реквизитов юрлица и публичных контактов (docs/11 §5.4.5).
 * bankDetails — приватное поле (наружу витрине не отдаётся, см. settings-dto).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;

export function LegalContactsForm({
  legalEntity,
  contacts,
}: {
  legalEntity: EffectiveSettings['legalEntity'];
  contacts: EffectiveSettings['contacts'];
}) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [name, setName] = useState(legalEntity.name ?? '');
  const [inn, setInn] = useState(legalEntity.inn ?? '');
  const [kpp, setKpp] = useState(legalEntity.kpp ?? '');
  const [ogrn, setOgrn] = useState(legalEntity.ogrn ?? '');
  const [legalAddress, setLegalAddress] = useState(legalEntity.legalAddress ?? '');
  const [bankDetails, setBankDetails] = useState(legalEntity.bankDetails ?? '');

  const [phone, setPhone] = useState(contacts.phone ?? '');
  const [email, setEmail] = useState(contacts.email ?? '');
  const [address, setAddress] = useState(contacts.address ?? '');
  const [workingHours, setWorkingHours] = useState(contacts.workingHours ?? '');
  const [socials, setSocials] = useState<{ type: string; url: string }[]>(
    (contacts.socials ?? []).map((s) => ({ type: s.type, url: s.url })),
  );

  const addSocial = () => setSocials((prev) => [...prev, { type: '', url: '' }]);
  const removeSocial = (i: number) => setSocials((prev) => prev.filter((_, n) => n !== i));
  const setSocial = (i: number, field: 'type' | 'url', val: string) =>
    setSocials((prev) => prev.map((s, n) => (n === i ? { ...s, [field]: val } : s)));

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateLegalContactsAction({
      legalEntity: {
        name: name.trim() || undefined,
        inn: inn.trim() || undefined,
        kpp: kpp.trim() || undefined,
        ogrn: ogrn.trim() || undefined,
        legalAddress: legalAddress.trim() || undefined,
        bankDetails: bankDetails.trim() || undefined,
      },
      contacts: {
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        address: address.trim() || undefined,
        workingHours: workingHours.trim() || undefined,
        socials: socials
          .map((s) => ({ type: s.type.trim(), url: s.url.trim() }))
          .filter((s) => s.type && s.url),
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Реквизиты и контакты сохранены.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const fe = (f: string) => fieldError(error, f);

  return (
    <div>
      {error ? (
        <div role="alert" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {errorMessage(error)}
        </div>
      ) : null}
      {success ? (
        <div role="status" className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          {success}
        </div>
      ) : null}

      <h3 className="text-sm font-semibold text-gray-800">Реквизиты юрлица</h3>
      <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="l-name" className="block text-sm font-medium text-gray-700">Наименование</label>
          <input id="l-name" value={name} onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="l-inn" className="block text-sm font-medium text-gray-700">ИНН (10 или 12 цифр)</label>
          <input id="l-inn" value={inn} onChange={(e) => setInn(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('legalEntity.inn') ? <p className="mt-1 text-xs text-red-600">{fe('legalEntity.inn')}</p> : null}
        </div>
        <div>
          <label htmlFor="l-kpp" className="block text-sm font-medium text-gray-700">КПП (9 цифр)</label>
          <input id="l-kpp" value={kpp} onChange={(e) => setKpp(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('legalEntity.kpp') ? <p className="mt-1 text-xs text-red-600">{fe('legalEntity.kpp')}</p> : null}
        </div>
        <div>
          <label htmlFor="l-ogrn" className="block text-sm font-medium text-gray-700">ОГРН (13 или 15 цифр)</label>
          <input id="l-ogrn" value={ogrn} onChange={(e) => setOgrn(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('legalEntity.ogrn') ? <p className="mt-1 text-xs text-red-600">{fe('legalEntity.ogrn')}</p> : null}
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="l-addr" className="block text-sm font-medium text-gray-700">Юридический адрес</label>
          <input id="l-addr" value={legalAddress} onChange={(e) => setLegalAddress(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div className="lg:col-span-2">
          <label htmlFor="l-bank" className="block text-sm font-medium text-gray-700">
            Банковские реквизиты <span className="text-gray-400">(приватно, не публикуется)</span>
          </label>
          <textarea id="l-bank" value={bankDetails} onChange={(e) => setBankDetails(e.target.value)} rows={2}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-800">Публичные контакты</h3>
      <div className="mt-2 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div>
          <label htmlFor="ct-phone" className="block text-sm font-medium text-gray-700">Телефон</label>
          <input id="ct-phone" value={phone} onChange={(e) => setPhone(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="ct-email" className="block text-sm font-medium text-gray-700">Email</label>
          <input id="ct-email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
          {fe('contacts.email') ? <p className="mt-1 text-xs text-red-600">{fe('contacts.email')}</p> : null}
        </div>
        <div>
          <label htmlFor="ct-addr" className="block text-sm font-medium text-gray-700">Адрес</label>
          <input id="ct-addr" value={address} onChange={(e) => setAddress(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
        <div>
          <label htmlFor="ct-hours" className="block text-sm font-medium text-gray-700">Часы работы</label>
          <input id="ct-hours" value={workingHours} onChange={(e) => setWorkingHours(e.target.value)}
            className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm" />
        </div>
      </div>

      <h3 className="mt-6 text-sm font-semibold text-gray-800">Соцсети</h3>
      <p className="mt-1 text-xs text-gray-500">
        Ссылки в футере витрины. Тип — подпись (Instagram, Telegram…), адрес — ссылка.
      </p>
      <div className="mt-2 space-y-3">
        {socials.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              aria-label={`Соцсеть ${i + 1} — тип`}
              value={s.type}
              onChange={(e) => setSocial(i, 'type', e.target.value)}
              placeholder="Instagram"
              className="w-40 rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <input
              aria-label={`Соцсеть ${i + 1} — адрес`}
              value={s.url}
              onChange={(e) => setSocial(i, 'url', e.target.value)}
              placeholder="https://instagram.com/shop"
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => removeSocial(i)}
              className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              Удалить
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addSocial}
          className="rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          + Добавить соцсеть
        </button>
        {fe('contacts.socials') ? <p className="text-xs text-red-600">{fe('contacts.socials')}</p> : null}
      </div>

      <div className="mt-6 flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
    </div>
  );
}
