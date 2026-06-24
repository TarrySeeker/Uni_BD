// =============================================================================
// Admik — ESLint flat config (ESLint 9 + Next.js 16)
// =============================================================================
// Заменяет legacy .eslintrc.json. Опирается на eslint-config-next 16, который
// уже экспортирует flat config (массив) и включает:
//   - правила TypeScript (через bundled typescript-eslint)
//   - Next.js core-web-vitals
//   - react / react-hooks / jsx-a11y / import
// =============================================================================

import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

/** @type {import('eslint').Linter.Config[]} */
const config = [
  // Глобальные игнорируемые пути
  {
    ignores: [
      '.next/**',
      '.next/standalone/**',
      'node_modules/**',
      'next-env.d.ts',
      'dist/**',
      'build/**',
      // storefront — самостоятельный проект витрины (свой tsconfig/eslint,
      // gitignored, деплоится отдельно). В линт/typecheck Admik не входит.
      'storefront/**',
    ],
  },
  // База: Next 16 core-web-vitals + TypeScript
  ...nextCoreWebVitals,
];

export default config;
