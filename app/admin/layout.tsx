import type { ReactNode } from 'react';

import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';

/**
 * Провайдер i18n для ВСЕЙ админки (next-intl foundation, STEP G).
 *
 * Живёт на уровне /admin, поэтому оборачивает и `login` (сиблинг группы), и группу
 * `(panel)` — переводы доступны на странице входа и во всех защищённых разделах.
 * Тонкий серверный компонент: НЕ рендерит <html>/<body> (их владеет корневой
 * app/layout.tsx) и НЕ дублирует auth-каркас — существующий (panel)/layout.tsx с
 * requireUser остаётся вложенным внутрь этого провайдера без конфликта.
 *
 * locale/messages берутся из request-конфига next-intl (i18n/request.ts): язык из
 * cookie NEXT_LOCALE, каталог messages/<locale>.json.
 *
 * ВАЖНО (scope этого шага): провайдер лишь ДОСТАВЛЯЕТ каталог. Ни один компонент
 * пока не переключён на переводы — весь текст интерфейса остаётся хардкодом ru.
 */
export default async function AdminIntlLayout({
  children,
}: {
  children: ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}
