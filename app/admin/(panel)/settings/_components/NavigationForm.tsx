'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import type { ActionResult } from '@/lib/server/action';
import type { EffectiveSettings } from '@/lib/config/settings';

import { updateNavigationContentAction } from './form-actions';
import { errorMessage } from './action-result';

/**
 * Форма «Навигация и футер» (G-10/G-11): пункты меню шапки и колонки футера
 * витрины. Пусто → витрина показывает навигацию по умолчанию. Мутация —
 * updateNavigationContentAction (settings.manage).
 */
type Fail = Extract<ActionResult<unknown>, { ok: false }>;
type NavLink = { label: string; href: string };
type NavColumn = { title: string; links: NavLink[] };

export function NavigationForm({ navigation }: { navigation: EffectiveSettings['navigation'] }) {
  const router = useRouter();
  const [error, setError] = useState<Fail | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const [header, setHeader] = useState<NavLink[]>(navigation.header.map((l) => ({ ...l })));
  const [footer, setFooter] = useState<NavColumn[]>(
    navigation.footer.map((c) => ({ title: c.title, links: c.links.map((l) => ({ ...l })) })),
  );

  // --- меню шапки ---
  const addHeader = () => setHeader((p) => [...p, { label: '', href: '' }]);
  const removeHeader = (i: number) => setHeader((p) => p.filter((_, n) => n !== i));
  const setHeaderField = (i: number, f: keyof NavLink, v: string) =>
    setHeader((p) => p.map((l, n) => (n === i ? { ...l, [f]: v } : l)));

  // --- колонки футера ---
  const addColumn = () => setFooter((p) => [...p, { title: '', links: [] }]);
  const removeColumn = (ci: number) => setFooter((p) => p.filter((_, n) => n !== ci));
  const setColumnTitle = (ci: number, v: string) =>
    setFooter((p) => p.map((c, n) => (n === ci ? { ...c, title: v } : c)));
  const addColLink = (ci: number) =>
    setFooter((p) => p.map((c, n) => (n === ci ? { ...c, links: [...c.links, { label: '', href: '' }] } : c)));
  const removeColLink = (ci: number, li: number) =>
    setFooter((p) => p.map((c, n) => (n === ci ? { ...c, links: c.links.filter((_, m) => m !== li) } : c)));
  const setColLink = (ci: number, li: number, f: keyof NavLink, v: string) =>
    setFooter((p) =>
      p.map((c, n) =>
        n === ci ? { ...c, links: c.links.map((l, m) => (m === li ? { ...l, [f]: v } : l)) } : c,
      ),
    );

  async function save() {
    setPending(true);
    setError(null);
    setSuccess(null);
    const result = await updateNavigationContentAction({
      navigation: {
        header: header
          .map((l) => ({ label: l.label.trim(), href: l.href.trim() }))
          .filter((l) => l.label && l.href),
        footer: footer
          .map((c) => ({
            title: c.title.trim(),
            links: c.links
              .map((l) => ({ label: l.label.trim(), href: l.href.trim() }))
              .filter((l) => l.label && l.href),
          }))
          .filter((c) => c.title),
      },
    });
    setPending(false);
    if (result.ok) {
      setSuccess('Навигация сохранена.');
      router.refresh();
    } else {
      setError(result);
    }
  }

  const inputCls = 'rounded border border-gray-300 px-3 py-2 text-sm';
  const smallBtn = 'rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50';
  const addBtn = 'rounded border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50';

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

      <p className="mb-5 text-sm text-gray-600">
        Меню в шапке и колонки футера витрины. Если оставить пустым — витрина покажет
        навигацию по умолчанию. «Коллекция» из категорий каталога добавляется автоматически.
      </p>

      {/* Меню шапки */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Меню в шапке</legend>
        <div className="space-y-3">
          {header.map((l, i) => (
            <div key={i} className="flex items-center gap-2">
              <input aria-label={`Пункт ${i + 1} — название`} value={l.label}
                onChange={(e) => setHeaderField(i, 'label', e.target.value)} placeholder="Каталог" className={`w-48 ${inputCls}`} />
              <input aria-label={`Пункт ${i + 1} — ссылка`} value={l.href}
                onChange={(e) => setHeaderField(i, 'href', e.target.value)} placeholder="/catalog" className={`flex-1 ${inputCls}`} />
              <button type="button" onClick={() => removeHeader(i)} className={smallBtn}>Удалить</button>
            </div>
          ))}
          <button type="button" onClick={addHeader} className={addBtn}>+ Добавить пункт меню</button>
        </div>
      </fieldset>

      {/* Колонки футера */}
      <fieldset className="mb-6 rounded border border-gray-200 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">Колонки футера</legend>
        <div className="space-y-5">
          {footer.map((c, ci) => (
            <div key={ci} className="rounded border border-gray-200 p-3">
              <div className="flex items-center gap-2">
                <input aria-label={`Колонка ${ci + 1} — заголовок`} value={c.title}
                  onChange={(e) => setColumnTitle(ci, e.target.value)} placeholder="Сервис" className={`w-48 ${inputCls}`} />
                <button type="button" onClick={() => removeColumn(ci)} className={smallBtn}>Удалить колонку</button>
              </div>
              <div className="mt-3 space-y-2 pl-4">
                {c.links.map((l, li) => (
                  <div key={li} className="flex items-center gap-2">
                    <input aria-label={`Ссылка ${li + 1} — название`} value={l.label}
                      onChange={(e) => setColLink(ci, li, 'label', e.target.value)} placeholder="Доставка" className={`w-48 ${inputCls}`} />
                    <input aria-label={`Ссылка ${li + 1} — адрес`} value={l.href}
                      onChange={(e) => setColLink(ci, li, 'href', e.target.value)} placeholder="/delivery" className={`flex-1 ${inputCls}`} />
                    <button type="button" onClick={() => removeColLink(ci, li)} className={smallBtn}>×</button>
                  </div>
                ))}
                <button type="button" onClick={() => addColLink(ci)} className={addBtn}>+ Ссылка</button>
              </div>
            </div>
          ))}
          <button type="button" onClick={addColumn} className={addBtn}>+ Добавить колонку</button>
        </div>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-gray-200 pt-4">
        <button type="button" onClick={save} disabled={pending}
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50">
          {pending ? 'Сохранение…' : 'Сохранить навигацию'}
        </button>
      </div>
    </div>
  );
}
