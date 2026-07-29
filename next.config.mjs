import createNextIntlPlugin from 'next-intl/plugin';

// Плагин next-intl подключает request-конфиг ./i18n/request.ts (путь по умолчанию)
// — источник locale/messages для интерфейса админки. Роутинга по языку нет: язык
// берётся из cookie NEXT_LOCALE (см. i18n/request.ts).
const withNextIntl = createNextIntlPlugin();

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Не раскрывать стек наружу: заголовок `x-powered-by: Next.js` ничего не даёт
  // пользователю, но подсказывает атакующему, какие эксплойты пробовать.
  poweredByHeader: false,
  // Не бандлить драйвер БД в серверные чанки — держать внешним пакетом, чтобы он
  // трассировался в standalone/node_modules. Иначе db/seed/owner.mjs (отдельный
  // ESM-скрипт init-shop) не находит пакет 'postgres' в рантайм-образе.
  serverExternalPackages: ['postgres'],
  experimental: {
    // Загрузка фото товара идёт Server Action'ом (FormData). По умолчанию Next.js
    // режет тело Server Action на 1 МБ — реальные фото (2–5 МБ) падали с невнятной
    // ошибкой («Не загружает фото товара»). Поднимаем выше лимита медиа (10 МБ,
    // lib/storage/validate) + запас на multipart-оверхед. Сам файл всё равно
    // валидируется на сервере (magic-bytes + размер).
    serverActions: {
      bodySizeLimit: '12mb',
    },
  },
};

export default withNextIntl(nextConfig);
