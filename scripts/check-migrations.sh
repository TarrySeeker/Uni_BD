#!/usr/bin/env bash
# shellcheck disable=SC2059  # printf-форматы содержат только статические ANSI-цвета (без % и пользовательских данных)
# =============================================================================
# Admik — статический линтер обратной совместимости миграций (Этап 6, пакет 6.4)
# =============================================================================
# Проверяет SQL-миграции на ЗАПРЕЩЁННЫЕ деструктивные DDL. Ключевой инвариант
# §6.4/ADR-015: ИДЕМПОТЕНТНОСТЬ (IF NOT EXISTS) ≠ ОБРАТНАЯ СОВМЕСТИМОСТЬ.
# Во время выката старый и новый код приложения ОДНОВРЕМЕННО работают с новой
# схемой, поэтому миграции должны быть только АДДИТИВНЫМИ. `DROP COLUMN`
# идемпотентен, но ломает ещё работающий старый код → запрещён.
#
# -----------------------------------------------------------------------------
# Точный список запрещённых конструкций и обоснование (§6.4 «Запрещено в одном
# релизе»). Проверки регистронезависимы и игнорируют SQL-комментарии `--`.
# -----------------------------------------------------------------------------
#   1. DROP TABLE        — удаление таблицы: старый код, читающий её, упадёт.
#   2. DROP COLUMN       — удаление колонки: старый код, ссылающийся на неё, упадёт
#                          (INSERT без значения / SELECT колонки).
#   3. DROP CONSTRAINT   — снятие ограничения МОЖЕТ молча разрешить данные, которые
#                          старый код считает невозможными (инвариант нарушен).
#                          Запрещаем целиком ради простоты (CHECK/FK/UNIQUE — все).
#                          Снятие ограничения — через expand/contract, не в одном
#                          релизе с зависимым кодом.
#                          ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ (carve-out ADR-P1-2, docs/24 §7):
#                          РАСШИРЕНИЕ множества значений CHECK — семантически
#                          аддитивно (новое множество ⊇ старого, ни одно прежде
#                          валидное значение не отвергается). Разрешаем DROP
#                          CONSTRAINT ТОЛЬКО когда в ТОМ ЖЕ файле выполнены ВСЕ
#                          условия одновременно:
#                            (a) присутствует явный маркер-комментарий
#                                `-- check-migrations:allow-widen-check <proof>`
#                                (proof = человекочитаемое доказательство superset,
#                                 owner-signed по ADR-P1-2), И
#                            (b) то же имя ограничения немедленно пересоздаётся:
#                                `ADD CONSTRAINT <same-name> CHECK (...)`.
#                          Superset статически не доказуем (эвристика по токенам) —
#                          он подтверждается человеком в тексте proof. Любой DROP
#                          CONSTRAINT без маркера ИЛИ без парного ADD ... CHECK того
#                          же имени по-прежнему ОТВЕРГАЕТСЯ. DROP TABLE/COLUMN/INDEX,
#                          RENAME и пр. carve-out НЕ затрагивает.
#   4. DROP DEFAULT      — снятие DEFAULT: старый код, полагавшийся на дефолт при
#                          INSERT без значения, начнёт получать NULL/ошибку.
#   5. DROP NOT NULL     — само по себе ослабление допустимо, НО оно сужает гарантии,
#                          на которые мог опираться старый код (не-NULL). Запрещаем
#                          для строгости совместимости в одном релизе.
#   6. ALTER ... RENAME  — переименование таблицы/колонки/constraint: старый код
#                          обращается по прежнему имени → мгновенно ломается.
#                          (RENAME — классический НЕ-аддитивный приём.)
#   7. ALTER COLUMN ... TYPE / ALTER COLUMN ... SET DATA TYPE — смена/сужение типа:
#                          может потерять данные и сломать ожидания старого кода.
#   8. ALTER COLUMN ... SET NOT NULL БЕЗ сопутствующего DEFAULT — старый код,
#                          вставляющий строки без этой колонки, начнёт падать.
#                          (С DEFAULT в той же инструкции — допустимо, т.к. вставка
#                          без значения получит дефолт. Эвристика: ловим SET NOT NULL,
#                          но пропускаем, если в той же инструкции есть DEFAULT.)
#   9. ALTER TYPE ... DROP VALUE / RENAME VALUE — удаление/переименование значения
#                          enum: старый код, пишущий это значение, упадёт. (Postgres
#                          и так не умеет DROP VALUE напрямую, но ловим явный запрет.)
#  10. DROP INDEX        — снятие индекса УБИРАЕТ инвариант. В Admik уникальность и
#                          идемпотентность держатся именно на UNIQUE-индексах
#                          (orders_idempotency_uniq, orders_number_uniq,
#                          uq_tbank_payment_log_idem, uq_cdek_status_idem,
#                          inventory_unit_uniq, promo_redemptions_order_uniq,
#                          customers_email_uniq, users_email_uniq), часть — partial
#                          (только индекс, не constraint). Снятие такого индекса в
#                          одном релизе молча возвращает дубли/двойные списания —
#                          только expand/contract. Ловит DROP INDEX [IF EXISTS] и
#                          DROP INDEX CONCURRENTLY (оба идут после токенов DROP INDEX).
#
# РАЗРЕШЕНО (НЕ ловится, проверено на реальных 0001–0024):
#   ADD COLUMN [IF NOT EXISTS] ... [NOT NULL DEFAULT ...]  — аддитивно;
#   CREATE TABLE/INDEX/... IF NOT EXISTS                    — аддитивно;
#   ALTER TABLE ... ADD CONSTRAINT ... CHECK (... NOT VALID) — расширение;
#   ON DELETE CASCADE / IS NOT NULL / NOT NULL в CREATE TABLE — НЕ деструктив;
#   DROP CONSTRAINT <name> + ADD CONSTRAINT <name> CHECK(...) под маркером
#     `-- check-migrations:allow-widen-check <proof>` — расширение множества CHECK
#     (carve-out ADR-P1-2, см. правило №3 выше). ТОЛЬКО эта пара, ТОЛЬКО с маркером.
#
# Эвристика, не доказательство (как и сказано в §6.4): ловит очевидные нарушения
# по токенам, не парсит SQL целиком. Цель — заблокировать заведомо опасный выкат.
#
# -----------------------------------------------------------------------------
# Аргументы: список .sql-файлов. Без аргументов — все db/migrations/*.sql.
# Код возврата: 0 — все файлы чисты; ≠0 — найдено нарушение (печатает файл:строку
# и что именно нарушено).
#
# Зависимости: только awk (POSIX; проверено на mawk и gawk).
#
# ПРОИЗВОДИТЕЛЬНОСТЬ/НАДЁЖНОСТЬ: вся проверка выполняется ОДНИМ процессом awk на
# ВЕСЬ список файлов (bash только печатает готовый результат встроенными командами).
# Раньше на каждый файл порождалось ~17 подпроцессов (grep/sed/awk/cut/tr/sort в
# циклах) — на 55 миграциях это ~950 exec и ~2300 fork. Под нагрузкой (полный
# прогон vitest в 16 воркеров) fork временами не проходил с EAGAIN, и линтер падал
# с ненулевым кодом БЕЗ реального нарушения схемы — гейт флакал. Теперь число
# процессов КОНСТАНТНО (не зависит от количества миграций), флак устранён по корню.
#
# Запуск:
#   ./scripts/check-migrations.sh                      # все db/migrations/*.sql
#   ./scripts/check-migrations.sh path/to/0099_x.sql   # конкретные файлы
# =============================================================================

set -euo pipefail

# Цвета (только если stdout — терминал).
if [ -t 1 ]; then
  GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=''; YELLOW=''; RED=''; BOLD=''; NC=''
fi

step()  { printf "${BOLD}==>${NC} %s\n" "$1"; }
ok()    { printf "${GREEN}  ✔${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}  ⚠${NC} %s\n" "$1"; }
fail()  { printf "${RED}  ✗${NC} %s\n" "$1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# -----------------------------------------------------------------------------
# Список файлов: из аргументов или все db/migrations/*.sql.
# -----------------------------------------------------------------------------
FILES=()
if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  shopt -s nullglob
  FILES=("${PROJECT_ROOT}/db/migrations"/*.sql)
  shopt -u nullglob
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  warn "Нет .sql-файлов для проверки — нечего линтить (exit 0)."
  exit 0
fi

printf "${BOLD}=== Admik · линтер аддитивности миграций ===${NC}\n"
printf "Файлов к проверке: %s\n\n" "${#FILES[@]}"

violations_total=0
RC=0

# Отсутствующие файлы отсеиваем здесь (test -f — встроенная команда, без fork).
EXISTING=()
for f in "${FILES[@]}"; do
  if [ ! -f "${f}" ]; then
    fail "Файл не найден: ${f}"
    RC=1
    continue
  fi
  EXISTING+=("${f}")
done

# -----------------------------------------------------------------------------
# ЯДРО: единственный процесс awk на весь список файлов.
# -----------------------------------------------------------------------------
# awk сам открывает файлы через getline (а не через штатный цикл записей) — это
# позволяет получить корректные S/O-строки даже для ПУСТЫХ файлов и не зависеть от
# трактовки аргументов вида `var=value` как присваиваний.
#
# Протокол вывода (поля разделены табом; в инструкциях табов нет — whitespace
# схлопнут в пробелы, в идентификаторах правил табов нет по построению):
#   S <file>                        — начало проверки файла
#   V <file> <line> <rule> <stmt>   — нарушение
#   O <file>                        — файл чист
# Тексты причин живут в bash (case ниже), чтобы не дублировать их в двух языках.
#
# Нормализация (та же, что раньше): файл превращается в поток ЛОГИЧЕСКИХ SQL-
# инструкций. Это критично: деструктивный DDL может быть разнесён по физическим
# строкам (`ALTER ... DROP\n COLUMN ...`), и построчный матч его пропускал.
#   1. хвостовой `--`-комментарий срезается (DROP в комментарии — не нарушение);
#   2. строки аккумулируются, любые последовательности whitespace (включая \n)
#      схлопываются в один пробел;
#   3. каждый `;` закрывает инструкцию; запоминается номер ИСХОДНОЙ строки, на
#      которой инструкция началась;
#   4. хвост без завершающего `;` тоже проверяется.
# Блочные /* */ комментарии в миграциях проекта не используются — намеренно не
# усложняем (эвристика, как и сказано в §6.4).
#
# Матчинг регистронезависим за счёт tolower() над инструкцией (IGNORECASE есть
# только в gawk, нам нужен и mawk).
AWK_PROG='
function flush_stmt(   s) {
  s = g_cur
  gsub(/[[:space:]]+/, " ", s)
  sub(/^ /, "", s)
  sub(/ $/, "", s)
  if (s != "") { g_ns++; stx[g_ns] = s; stl[g_ns] = g_start }
  g_cur = ""
  g_start = 0
}

function emit(f, ln, rule, s) {
  printf "V\t%s\t%d\t%s\t%s\n", f, ln, rule, s
  g_fileviol++
}

# Множество имён ограничений, пересоздаваемых в ЭТОМ файле через ADD CONSTRAINT
# <name> CHECK — кандидаты на «расширение» (carve-out ADR-P1-2).
function collect_widened(   k, p, st, ln, m, nm) {
  for (k = 1; k <= g_ns; k++) {
    p = tolower(stx[k])
    while (match(p, RE_ADDCHK)) {
      st = RSTART; ln = RLENGTH
      m = substr(p, st, ln)
      p = substr(p, st + ln)
      if (match(m, "[a-z0-9_\"]+[[:space:]]+check$")) {
        nm = substr(m, RSTART, RLENGTH)
        sub("[[:space:]]+check$", "", nm)
        widened[nm] = 1
      }
    }
  }
}

# Правило №3: DROP CONSTRAINT с точечным carve-out ADR-P1-2. Отдельным проходом,
# а не общим регэкспом, потому что решение зависит от ИМЕНИ ограничения и от
# наличия парного ADD ... CHECK того же имени в том же файле.
function check_drop_constraint(f,   k, low, m, n, tk, dname) {
  for (k = 1; k <= g_ns; k++) {
    low = tolower(stx[k])
    if (!match(low, RE_DROPCON)) continue
    dname = ""
    if (match(low, RE_DROPCON_NAME)) {
      m = substr(low, RSTART, RLENGTH)
      n = split(m, tk, "[[:space:]]+")
      dname = tk[n]
    }
    if (g_marker == 1 && dname != "" && (dname in widened)) continue
    emit(f, stl[k], "drop_constraint", stx[k])
  }
}

# Правило №8: SET NOT NULL без DEFAULT в той же ИНСТРУКЦИИ (с DEFAULT — безопасно,
# вставка без значения получит дефолт).
function check_set_not_null(f,   k, low) {
  for (k = 1; k <= g_ns; k++) {
    low = tolower(stx[k])
    if (!match(low, RE_SETNN)) continue
    if (index(low, "default") > 0) continue
    emit(f, stl[k], "set_not_null", stx[k])
  }
}

function lint_file(f,   line, lineno, pos, i, n, parts, seg, probe, j, k) {
  printf "S\t%s\n", f

  delete stx; delete stl; delete widened
  g_ns = 0; g_cur = ""; g_start = 0; g_marker = 0; g_fileviol = 0

  lineno = 0
  while ((getline line < f) > 0) {
    lineno++
    # Маркер carve-out ищем в СЫРОЙ строке: он живёт в --комментарии, который
    # ниже срезается. Требуем непустой <proof> — owner-signed по ADR-P1-2.
    if (g_marker == 0 && match(tolower(line), RE_MARKER)) g_marker = 1

    pos = index(line, "--")
    if (pos > 0) line = substr(line, 1, pos - 1)

    n = split(line, parts, ";")
    for (i = 1; i <= n; i++) {
      seg = parts[i]
      if (g_cur == "" && g_start == 0) {
        probe = seg
        gsub(/[[:space:]]+/, "", probe)
        if (probe != "") g_start = lineno
      }
      g_cur = g_cur " " seg
      if (i < n) flush_stmt()
    }
  }
  close(f)
  flush_stmt()

  collect_widened()

  # Порядок правил ФИКСИРОВАН — он определяет порядок строк в отчёте.
  for (j = 1; j <= g_nrules; j++) {
    if (rid[j] == "@drop_constraint") { check_drop_constraint(f); continue }
    if (rid[j] == "@set_not_null")    { check_set_not_null(f);    continue }
    for (k = 1; k <= g_ns; k++) {
      if (match(tolower(stx[k]), rre[j])) emit(f, stl[k], rid[j], stx[k])
    }
  }

  if (g_fileviol == 0) printf "O\t%s\n", f
}

BEGIN {
  RE_MARKER       = "check-migrations:allow-widen-check[[:space:]]+[^[:space:]]"
  RE_ADDCHK       = "add[[:space:]]+constraint[[:space:]]+[a-z0-9_\"]+[[:space:]]+check"
  RE_DROPCON      = "drop[[:space:]]+constraint"
  RE_DROPCON_NAME = "drop[[:space:]]+constraint[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?[a-z0-9_\"]+"
  RE_SETNN        = "set[[:space:]]+not[[:space:]]+null"

  g_nrules = 0
  rid[++g_nrules] = "drop_table";        rre[g_nrules] = "drop[[:space:]]+table"
  rid[++g_nrules] = "drop_column";       rre[g_nrules] = "drop[[:space:]]+column"
  rid[++g_nrules] = "@drop_constraint";  rre[g_nrules] = ""
  rid[++g_nrules] = "drop_default";      rre[g_nrules] = "drop[[:space:]]+default"
  rid[++g_nrules] = "drop_not_null";     rre[g_nrules] = "drop[[:space:]]+not[[:space:]]+null"
  rid[++g_nrules] = "rename";            rre[g_nrules] = "alter[[:space:]]+.*rename|rename[[:space:]]+(to|column|constraint)"
  rid[++g_nrules] = "alter_type";        rre[g_nrules] = "alter[[:space:]]+(column[[:space:]]+)?[a-z_\"]+[[:space:]]+(set[[:space:]]+data[[:space:]]+)?type|set[[:space:]]+data[[:space:]]+type"
  rid[++g_nrules] = "enum_value";        rre[g_nrules] = "alter[[:space:]]+type[[:space:]]+.*(drop|rename)[[:space:]]+value|drop[[:space:]]+value"
  rid[++g_nrules] = "drop_index";        rre[g_nrules] = "drop[[:space:]]+index"
  rid[++g_nrules] = "@set_not_null";     rre[g_nrules] = ""

  for (ai = 1; ai < ARGC; ai++) lint_file(ARGV[ai])
  exit 0
}
'

LINT_RAW=''
if [ "${#EXISTING[@]}" -gt 0 ]; then
  if ! LINT_RAW="$(awk "${AWK_PROG}" "${EXISTING[@]}")"; then
    fail "внутренняя ошибка линтера (awk завершился с ошибкой)"
    exit 2
  fi
fi

# -----------------------------------------------------------------------------
# Печать отчёта. Цикл целиком на встроенных командах bash — ни одного fork.
# -----------------------------------------------------------------------------
while IFS=$'\t' read -r kind a b c d; do
  case "${kind}" in
    S)
      step "Проверяю ${a##*/}"
      ;;
    O)
      ok "аддитивна — нарушений не найдено"
      ;;
    V)
      case "${c}" in
        drop_table)
          reason='запрещён DROP TABLE (удаление таблицы ломает старый код; expand/contract)' ;;
        drop_column)
          reason='запрещён DROP COLUMN (удаление колонки ломает старый код; expand/contract)' ;;
        drop_constraint)
          reason='запрещён DROP CONSTRAINT (снятие инварианта в одном релизе; expand/contract). Расширение множества CHECK — только парой DROP+ADD того же имени под маркером -- check-migrations:allow-widen-check <proof> (ADR-P1-2)' ;;
        drop_default)
          reason='запрещён DROP DEFAULT (старый код, полагавшийся на дефолт, сломается)' ;;
        drop_not_null)
          reason='запрещён DROP NOT NULL (ослабление гарантии в одном релизе)' ;;
        rename)
          reason='запрещён RENAME (переименование ломает обращение старого кода по имени)' ;;
        alter_type)
          reason='запрещена смена типа колонки (ALTER [COLUMN] ... TYPE; возможна потеря данных)' ;;
        enum_value)
          reason='запрещено удаление/переименование значения enum (ломает запись старым кодом)' ;;
        drop_index)
          reason='запрещён DROP INDEX (снятие индекса убирает инвариант уникальности/идемпотентности; expand/contract)' ;;
        set_not_null)
          reason='запрещён SET NOT NULL без DEFAULT (старый код, вставляющий без значения, упадёт)' ;;
        *)
          reason="нарушение аддитивности (${c})" ;;
      esac
      fail "${a}:${b}: ${reason}"
      printf "        ${YELLOW}%s${NC}\n" "${d}" >&2
      violations_total=$((violations_total + 1))
      RC=1
      ;;
  esac
done <<< "${LINT_RAW}"

# -----------------------------------------------------------------------------
# Итог.
# -----------------------------------------------------------------------------
printf "\n"
if [ "${violations_total}" -eq 0 ] && [ "${RC}" -eq 0 ]; then
  printf "${GREEN}${BOLD}OK${NC} — все миграции аддитивны (обратно совместимы).\n"
  exit 0
fi

fail "НАЙДЕНЫ нарушения аддитивности: ${violations_total}."
warn "Деструктивные изменения схемы — только многошаговым expand/contract через"
warn "несколько релизов (§6.4, ADR-015). Исправьте миграции и повторите."
exit 1
