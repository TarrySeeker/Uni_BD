'use client';

/**
 * Форма подписки на рассылку в подвале витрины (эталон
 * `.footer-top__subscriptions-form` + `.fp-success`, docs/41 §1).
 *
 * 🔴 ПРИЁМНИК ПОДПИСОК — СУЩЕСТВУЮЩИЙ. Шлём в `POST /api/storefront/v1/newsletter`
 * (G-12) через api.subscribeNewsletter: тот же конвейер runStorefront (авторизация
 * по ключу/Origin → rate-limit → CORS), та же схема NewsletterInputSchema, та же
 * идемпотентная запись в `newsletter_subscribers` (ON CONFLICT DO NOTHING) — то
 * есть подписка из подвала попадает ровно в тот раздел «Подписчики», где уже лежат
 * перенесённые адреса. Своего эндпоинта форма НЕ заводит.
 *
 * Разметка повторяет эталон: поле и кнопка на одной линии внутри
 * `.footer-top__subscriptions-form`, мелкая приписка `<p class="description">`
 * ниже, блок `.fp-success` вместо формы после успеха.
 *
 * Тексты — из словаря локали (`dict.footer.*`), русских литералов в JSX нет.
 * Адрес НЕ логируем и никуда, кроме API подписки, не отправляем.
 */

import { useState } from 'react';
import { subscribeNewsletter } from '@/lib/api';

/** Мягкая проверка формы адреса ДО сети: строгая живёт в Zod на сервере. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export interface NewsletterFormTexts {
  placeholder: string;
  submitLabel: string;
  note: string;
  successTitle: string;
  errorText: string;
  invalidText: string;
  ariaLabel: string;
}

export default function NewsletterForm({ texts }: { texts: NewsletterFormTexts }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (status === 'sending') return;
    if (!looksLikeEmail(email)) {
      setStatus('error');
      setMessage(texts.invalidText);
      return;
    }
    setStatus('sending');
    setMessage('');
    try {
      await subscribeNewsletter(email.trim());
      // Успех идемпотентен: повторная подписка тем же адресом тоже «спасибо»
      // (сервер не раскрывает, был ли адрес уже в базе).
      setStatus('done');
      setEmail('');
    } catch {
      // Причину (сеть / 429 / 5xx) покупателю не детализируем — и не логируем
      // адрес. Показываем нейтральное «попробуйте позже», форма остаётся.
      setStatus('error');
      setMessage(texts.errorText);
    }
  }

  if (status === 'done') {
    // Эталон держит .fp-success в разметке всегда и показывает его после отправки;
    // здесь блок просто заменяет форму — визуально результат тот же.
    return (
      <div className="fp-success" style={{ display: 'block' }} role="status">
        <h3 className="fp-success__title">{texts.successTitle}</h3>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="footer-top__subscriptions-form">
        <input
          type="text"
          inputMode="email"
          autoComplete="email"
          aria-label={texts.ariaLabel}
          placeholder={texts.placeholder}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (status === 'error') {
              setStatus('idle');
              setMessage('');
            }
          }}
        />
        <input type="submit" value={texts.submitLabel} disabled={status === 'sending'} />
      </div>
      <div>
        {message ? (
          <p className="description" role="alert">
            {message}
          </p>
        ) : (
          <p className="description">{texts.note}</p>
        )}
      </div>
    </form>
  );
}
