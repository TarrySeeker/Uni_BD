import { describe, it, expect, beforeEach } from 'vitest';
import {
  createRateLimiter,
  MemoryRateBackend,
  MEMORY_RATE_MAX_ENTRIES,
  RATE_LIMIT,
} from '@/lib/auth/rate-limit';

describe('auth/rate-limit (mock / in-memory)', () => {
  let limiter: ReturnType<typeof createRateLimiter>;

  beforeEach(() => {
    // Каждому тесту — свежий in-memory бэкенд, чтобы состояние не протекало.
    limiter = createRateLimiter({ backend: new MemoryRateBackend() });
  });

  it('по умолчанию запрос разрешён', async () => {
    const res = await limiter.checkLoginRate('login:fail:1.2.3.4');
    expect(res.allowed).toBe(true);
    expect(res.retryAfterSec).toBeUndefined();
  });

  it('блокирует после достижения порога неудач', async () => {
    const key = 'login:fail:1.2.3.4';
    for (let i = 0; i < RATE_LIMIT.maxAttempts; i++) {
      await limiter.registerLoginFailure(key);
    }
    const res = await limiter.checkLoginRate(key);
    expect(res.allowed).toBe(false);
    expect(res.retryAfterSec).toBeGreaterThan(0);
    expect(res.retryAfterSec).toBeLessThanOrEqual(RATE_LIMIT.windowSec);
  });

  it('ниже порога остаётся разрешённым', async () => {
    const key = 'login:fail:5.6.7.8';
    for (let i = 0; i < RATE_LIMIT.maxAttempts - 1; i++) {
      await limiter.registerLoginFailure(key);
    }
    const res = await limiter.checkLoginRate(key);
    expect(res.allowed).toBe(true);
  });

  it('resetLoginFailures снимает блокировку', async () => {
    const key = 'login:fail:1.2.3.4';
    for (let i = 0; i < RATE_LIMIT.maxAttempts; i++) {
      await limiter.registerLoginFailure(key);
    }
    expect((await limiter.checkLoginRate(key)).allowed).toBe(false);

    await limiter.resetLoginFailures(key);
    expect((await limiter.checkLoginRate(key)).allowed).toBe(true);
  });

  it('разные ключи независимы', async () => {
    const a = 'login:fail:a@example.com';
    const b = 'login:fail:b@example.com';
    for (let i = 0; i < RATE_LIMIT.maxAttempts; i++) {
      await limiter.registerLoginFailure(a);
    }
    expect((await limiter.checkLoginRate(a)).allowed).toBe(false);
    expect((await limiter.checkLoginRate(b)).allowed).toBe(true);
  });

  it('истёкшее окно сбрасывает счётчик', async () => {
    const backend = new MemoryRateBackend();
    const lim = createRateLimiter({ backend, windowSec: 1 });
    const key = 'login:fail:expiry';
    for (let i = 0; i < RATE_LIMIT.maxAttempts; i++) {
      await lim.registerLoginFailure(key);
    }
    expect((await lim.checkLoginRate(key)).allowed).toBe(false);

    // Принудительно состариваем запись в обход реального времени.
    backend.__advance(2_000);
    expect((await lim.checkLoginRate(key)).allowed).toBe(true);
  });
});

describe('auth/rate-limit (MemoryRateBackend — защита от роста памяти/OOM)', () => {
  it('прод-предел задан и положителен (MEMORY_RATE_MAX_ENTRIES)', () => {
    expect(MEMORY_RATE_MAX_ENTRIES).toBeGreaterThan(0);
    expect(Number.isInteger(MEMORY_RATE_MAX_ENTRIES)).toBe(true);
  });

  it('размер Map ограничен верхним пределом при ротации никогда-не-перечитываемых ключей', async () => {
    // Симуляция X-Forwarded-For rotation: атакующий вставляет N >> лимита
    // уникальных IP-ключей; reset не вызывается, ключи не перечитываются.
    // Малый предел через конструктор — быстрый тест без привязки к прод-значению.
    const cap = 100;
    const backend = new MemoryRateBackend(cap);
    const overshoot = cap * 3;
    for (let i = 0; i < overshoot; i++) {
      await backend.increment(`storefront:rate:10.0.${(i >> 8) & 255}.${i & 255}`, 60);
    }
    // Размер не должен расти неограниченно — он ограничен пределом.
    expect(backend.__size()).toBeLessThanOrEqual(cap);
  });

  it('истёкшие записи вычищаются при вставке (ленивая очистка по window-expiry)', async () => {
    const backend = new MemoryRateBackend(100);
    // Вставляем партию записей с коротким окном (но > предела, чтобы триггерить очистку).
    for (let i = 0; i < 150; i++) {
      await backend.increment(`old:${i}`, 1);
    }
    expect(backend.__size()).toBeGreaterThan(0);
    // Состариваем все записи за пределы окна.
    backend.__advance(2_000);
    // Новая вставка на пределе триггерит ленивую очистку истёкших.
    for (let i = 0; i < 100; i++) {
      await backend.increment(`fresh:${i}`, 60);
    }
    // Все 150 истёкших должны быть вычищены; остаются только свежие (≤ предел).
    expect(backend.__size()).toBeLessThanOrEqual(100);
  });

  it('активный ключ в пределах окна по-прежнему корректно лимитируется (счётчик не сбрасывается)', async () => {
    const cap = 100;
    const backend = new MemoryRateBackend(cap);
    const lim = createRateLimiter({ backend });
    const victim = 'login:fail:victim';

    // Доводим жертву до порога блокировки (count = maxAttempts).
    for (let i = 0; i < RATE_LIMIT.maxAttempts; i++) {
      await lim.registerLoginFailure(victim);
    }
    expect((await lim.checkLoginRate(victim)).allowed).toBe(false);

    // Затопляем бэкенд множеством чужих ключей (каждый count=1) → вытеснение.
    for (let i = 0; i < cap * 3; i++) {
      await lim.registerLoginFailure(`login:fail:flood-${i}`);
    }

    // Ключ жертвы (активный, у порога, count > флуд-записей) НЕ вытеснен:
    // вытесняются наименее опасные (count=1), счётчик жертвы не сброшен.
    expect((await lim.checkLoginRate(victim)).allowed).toBe(false);
    expect(backend.__size()).toBeLessThanOrEqual(cap);
  });
});
