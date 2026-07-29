import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GUARD: бэкап не имеет права молча пропустить медиа на проде.
 *
 * ЖИВАЯ НАХОДКА 2026-07-29 (стенд erfgv.website): каталог `/backups/media` был
 * пуст с 15 июля — 819 МБ фотографий товаров не были защищены НИ ОДНОЙ копией,
 * при том что 15 ежедневных прогонов подряд рапортовали «Бэкап готов».
 *
 * Цепочка из двух звеньев:
 *   1) `mc` (MinIO Client) качается ОДИН раз при старте контейнера. 15.07 закачка
 *      сорвалась по таймауту (`wget: download timed out`), ретрая не было —
 *      разовый сбой сети стал постоянным состоянием на 13 дней.
 *   2) `backup.sh` трактовал отсутствие `mc` как норму: `warn` + продолжение с
 *      кодом 0, с формулировкой «это нормально для dev без медиа». На проде с
 *      непустым бакетом это не норма, а тихий отказ бэкапа.
 *
 * Дамп БД фотографии НЕ содержит — только ключи. Потеря тома `minio_data`
 * означала бы безвозвратную потерю всего каталога изображений.
 *
 * Сторожим ПРИЧИНУ, а не симптом: (1) закачка `mc` обязана повторяться,
 * (2) отсутствие `mc` при заданных ключах S3 обязано быть ошибкой с ненулевым
 * кодом выхода, а не предупреждением.
 */
describe('GUARD: медиа-бэкап не пропускается молча', () => {
  const root = process.cwd();
  const backupSh = readFileSync(join(root, 'scripts/backup.sh'), 'utf8');
  const compose = readFileSync(join(root, 'docker-compose.yml'), 'utf8');

  it('отсутствие mc при заданных ключах S3 — фатальная ошибка, а не warn', () => {
    // Прежняя формулировка «это нормально для dev без медиа» уводила от сути:
    // на проде с непустым бакетом это тихая потеря данных.
    expect(backupSh).not.toMatch(/это нормально для dev без медиа/);

    // Ветка «mc не найден» обязана звать fail и выходить с ненулевым кодом,
    // когда S3 сконфигурирован (то есть медиа реально есть что бэкапить).
    const mcMissingBranch = backupSh.slice(
      backupSh.indexOf('MinIO Client (mc) не найден'),
      backupSh.indexOf('MinIO Client (mc) не найден') + 700,
    );
    expect(mcMissingBranch).toMatch(/fail /);
    expect(mcMissingBranch).toMatch(/exit 1/);
  });

  it('сбой mc mirror — фатальная ошибка: «БД сохранена» не означает «бэкап готов»', () => {
    // Раньше сбой зеркалирования гасился в warn, и скрипт печатал «Бэкап готов».
    // Берём именно ветку обработки неудачи mirror, а не весь хвост файла:
    // иначе `exit 1` из любого места ниже давал бы ложно-зелёный тест.
    // Ищем сам ВЫЗОВ (`if mc mirror ...`), а не упоминание в комментарии выше.
    const from = backupSh.indexOf('if mc mirror');
    expect(from).toBeGreaterThan(-1);
    const mirrorBranch = backupSh.slice(from, from + 600);
    expect(mirrorBranch).toMatch(/fail /);
    expect(mirrorBranch).toMatch(/exit 1/);
    // Прежняя формулировка успокаивала: «медиа НЕ обновлено (БД-дамп уже готов)».
    expect(mirrorBranch).not.toMatch(/БД-дамп уже готов/);
  });

  it('закачка mc в контейнере backup повторяется, а не сдаётся с первого раза', () => {
    // Разовый сетевой таймаут не должен выводить медиа-бэкап из строя навсегда.
    const backupSvc = compose.slice(compose.indexOf('  backup:'));
    expect(backupSvc).toMatch(/for\s+\w+\s+in\s+1\s+2\s+3|while .*retry|--tries=/);
    // Таймаут у wget обязателен: без него закачка висит вместо повтора.
    expect(backupSvc).toMatch(/wget[^\n]*-T\s*\d+|--timeout=/);
  });

  it('BACKUP_DIR задан в окружении сервиса, а не только в команде запуска', () => {
    // ЖИВАЯ НАХОДКА: `export BACKUP_DIR=/backups` стоял внутри `command`, поэтому
    // при запуске через `docker compose exec backup /scripts/backup.sh` переменной
    // не было. PROJECT_ROOT вычислялся от `/`, и зеркало уходило в `/media`
    // ВНУТРИ контейнера — то есть в слой, исчезающий при пересоздании.
    // Это опаснее пустого бэкапа: копия выглядит сделанной, но её нет.
    const backupSvc = compose.slice(
      compose.indexOf('  backup:'),
      compose.indexOf('  backup:') + 2500,
    );
    // Именно в блоке `environment:` сервиса — в YAML-синтаксисе `KEY: value`.
    // `export BACKUP_DIR=...` внутри `command:` не считается: он и был причиной.
    const envStart = backupSvc.indexOf('environment:');
    expect(envStart).toBeGreaterThan(-1);
    const envBlock = backupSvc.slice(envStart, backupSvc.indexOf('command:', envStart));
    expect(envBlock).toMatch(/^\s+BACKUP_DIR:\s*\S*\/backups/m);
  });
});
