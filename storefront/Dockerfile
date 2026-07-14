# =============================================================================
# Витрина carre (Storefront) — multi-stage Dockerfile для Next.js 16 (standalone).
# По образцу Uni_BD/Dockerfile, но легче: витрина — тонкий потребитель API, без
# БД, sharp и init-скриптов. Этапы: deps -> build -> runner (standalone :3000).
# =============================================================================

FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
# pnpm через corepack. Пин 9.15.9 под Node 20 (совместим с lockfileVersion 9.0;
# pnpm 11.x требует node:sqlite из Node 22+ и падает на node:20-alpine).
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# -----------------------------------------------------------------------------
# deps — установка зависимостей (кешируется отдельно от исходников)
# -----------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
# Витрина не в workspace монорепо — ставим изолированно (--ignore-workspace).
RUN if [ -f pnpm-lock.yaml ]; then \
      pnpm install --frozen-lockfile --ignore-workspace; \
    else \
      echo "pnpm-lock.yaml не найден — установка без frozen-lockfile" && \
      pnpm install --ignore-workspace; \
    fi

# -----------------------------------------------------------------------------
# build — сборка в standalone
# -----------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Публичный адрес API впекается в клиентский бандл (checkout/автокомплит СДЭК).
# Пробрасывается docker-compose из build.args.NEXT_PUBLIC_ADMIK_API_URL.
ARG NEXT_PUBLIC_ADMIK_API_URL
ENV NEXT_PUBLIC_ADMIK_API_URL=${NEXT_PUBLIC_ADMIK_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# -----------------------------------------------------------------------------
# runner — минимальный рантайм
# -----------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Публичные ассеты (скопированный дизайн carre: app.css, шрифты, изображения).
COPY --from=build --chown=nextjs:nodejs /app/public ./public
# Standalone-сервер Next.js (включает минимальный node_modules).
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
# Статика Next.js (.next/static обслуживается standalone-сервером).
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

# server.js генерируется Next.js в standalone-выводе
CMD ["node", "server.js"]
