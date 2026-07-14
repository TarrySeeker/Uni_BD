import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Интеграционный тир (запуск С DATABASE_URL) накатывает миграции
    // суперпользователем и мутирует ОБЩУЮ схему public. Параллельный запуск файлов
    // даёт гонки DDL на общем каталоге («tuple concurrently updated») и перекашивает
    // чувствительные к таймингу race-тесты (напр. гонка списания gift-сертификата).
    // Поэтому при активном интеграционном тире файлы гоняем ПОСЛЕДОВАТЕЛЬНО. Условие
    // совпадает со skipIf интеграционных describe (TEST_DATABASE_URL ?? DATABASE_URL),
    // чтобы сериализация включалась ровно тогда, когда эти тесты реально исполняются
    // (в т.ч. в CI, где может быть задан лишь TEST_DATABASE_URL). Канонический прогон
    // без обеих переменных остаётся полностью параллельным (быстрым).
    fileParallelism: !(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
