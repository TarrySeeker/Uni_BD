/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
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

export default nextConfig;
