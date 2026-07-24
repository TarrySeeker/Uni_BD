/**
 * Best-effort переводчик интерфейса админки для серверных путей, которые
 * локализуют текст ВНЕ пайплайна defineAction (например, резолвят подписи
 * статусов, встраиваемые в параметры ошибки перехода).
 *
 * В реквест-контексте отдаёт переводчик в языке оператора (cookie NEXT_LOCALE →
 * users.ui_locale, см. i18n/request.ts). Вне контекста (юнит-тесты) или для
 * несуществующего ключа — возвращает ключ КАК ЕСТЬ (passthrough), поэтому вызов
 * никогда не бросает и не ломает тесты без next-контекста. next-intl/server
 * импортируется ДИНАМИЧЕСКИ — чтобы юнит-импорт вызывающего модуля не тянул
 * серверный API.
 */
export async function adminTranslator(): Promise<(key: string) => string> {
  try {
    const { getTranslations } = await import('next-intl/server');
    const t = await getTranslations();
    return (key: string) => (t.has(key) ? t(key) : key);
  } catch {
    return (key: string) => key;
  }
}
