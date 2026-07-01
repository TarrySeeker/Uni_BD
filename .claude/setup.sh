#!/usr/bin/env bash
# =============================================================================
# Uni_BD — преполётная настройка инструментов Claude для НОВОЙ сессии.
#
# Запусти ОДИН раз сразу после клонирования репозитория:
#     bash .claude/setup.sh
#
# Зачем: закоммиченный .claude/settings.json включает MCP-серверы, но Claude Code
# применяет его ТОЛЬКО после того, как ты один раз подтвердишь доверие к папке
# (trust dialog). Этот скрипт пишет .claude/settings.local.json, который
# действует СРАЗУ (даже до подтверждения доверия), и проверяет предпосылки.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Uni_BD: настройка инструментов Claude ==="

# 1) settings.local.json — включает MCP-серверы локально, без trust-диалога.
cat > .claude/settings.local.json <<'JSON'
{
  "enabledMcpjsonServers": ["playwright", "context7", "firecrawl", "glyph"]
}
JSON
echo "✓ .claude/settings.local.json записан (MCP включены локально)"

# 2) Node.js — ОБЯЗАТЕЛЕН для npx-серверов (playwright, context7, firecrawl).
if command -v node >/dev/null 2>&1; then
  echo "✓ Node.js $(node --version)"
else
  echo "⚠ Node.js НЕ найден — установи Node ≥ 20."
  echo "   Без него playwright / context7 / firecrawl не поднимутся."
fi

# 3) FIRECRAWL_API_KEY — ОПЦИОНАЛЕН (веб-ресёрч: доки СДЭК/Т-Банк, импорт каталога).
if [ -n "${FIRECRAWL_API_KEY:-}" ]; then
  echo "✓ FIRECRAWL_API_KEY задан"
else
  echo "ℹ FIRECRAWL_API_KEY не задан — сервер firecrawl не поднимется."
  echo "   Это не критично; задай ключ в окружении, если нужен веб-ресёрч."
fi

# 4) glyph — ОПЦИОНАЛЬНЫЙ бинарь (символьная навигация по большому TS-репо).
if command -v glyph >/dev/null 2>&1; then
  echo "✓ glyph установлен"
else
  echo "ℹ glyph не установлен — необязателен; сессия работает без него."
fi

echo ""
echo "Готово. При первом открытии папки Claude Code один раз спросит доверие"
echo "к каталогу — подтверди, чтобы серверы из .claude/settings.json"
echo "подхватывались автоматически и в дальнейшем."
echo ""
echo "Дальше: открой сессию Claude и скажи «изучи проект и начни онбординг»"
echo "(или запусти скилл /onboard-shop) — см. START-HERE.md."
