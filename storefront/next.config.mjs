import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone-вывод: минимальный self-contained сервер для docker-образа
  // (см. Dockerfile, COPY .next/standalone). Порт 3000.
  output: 'standalone',
  reactStrictMode: true,
  // Не раскрывать стек наружу (см. тот же параметр в конфиге админки).
  poweredByHeader: false,
  // Корень проекта — папка витрины. Иначе Turbopack поднимается до монорепо
  // /home/coder/TS (там pnpm-workspace.yaml) и втягивает соседний код Admik.
  turbopack: {
    root: __dirname,
  },
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
