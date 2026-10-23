import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRolling } from '../src/lib/rolling';
import { RateLimiter } from '../src/lib/limiter';
import { decide } from '../src/lib/scheduler';
import { dayStart, HOUR } from '../src/lib/time';
import { PstrykClient, PstrykError, type FetchFn } from '../src/lib/client';
import { parseFrames, toPricePoint } from '../src/lib/parse';
import { analyze, cheapestHours, cheapestWindow } from '../src/lib/calc';
import type { PricePoint } from '../src/lib/types';

const pt = (start: number, p: number): PricePoint => ({ start, end: start + HOUR, buyGross: p, buyNet: p / 1.23, sellGross: null, isCheap: null, isExpensive: null });
const T = Date.parse('2026-10-23T11:00:00Z'); // 13:00 Warsaw (CEST)

test('rolling: exact hour boundary and shifting', () => {
    const pts = Array.from({ length: 30 }, (_, i) => pt(T + i * HOUR, i));
    assert.equal(buildRolling(pts, T)[0].point?.buyGross, 0);
    assert.equal(buildRolling(pts, T - 1)[0].point, null);
    const r = buildRolling(pts, T + HOUR + 5);
    assert.equal(r[0].point?.buyGross, 1);
    assert.equal(r[23].point?.buyGross, 24);
});

test('rolling: missing future hours are unavailable, not shifted', () => {
    const r = buildRolling([pt(T, 1), pt(T + HOUR, 2)], T + HOUR);
    assert.equal(r[0].point?.buyGross, 2);
    assert.equal(r[1].point, null);
    assert.equal(r.filter(s => s.point).length, 1);
});

test('rolling: crosses midnight and DST change', () => {
    const t = Date.parse('2026-10-24T20:00:00Z'); // before 25h day on 25 Oct
    const pts = Array.from({ length: 30 }, (_, i) => pt(t + i * HOUR, i));
    const r = buildRolling(pts, t);
    assert.equal(r[23].start, t + 23 * HOUR);
    assert.equal(r[23].point?.buyGross, 23);
});

test('dayStart handles 23h and 25h days in Europe/Warsaw', () => {
    const len = (d: string): number => (dayStart(Date.parse(d), 1) - dayStart(Date.parse(d))) / HOUR;
    assert.equal(len('2026-03-29T12:00:00Z'), 23);
    assert.equal(len('2026-10-25T12:00:00Z'), 25);
    assert.equal(len('2026-06-10T12:00:00Z'), 24);
    assert.equal(new Date(dayStart(Date.parse('2026-06-10T12:00:00Z'))).toISOString(), '2026-06-09T22:00:00.000Z');
});

test('limiter: counts at request start, independent of duration', () => {
    const l = new RateLimiter(3);
    [0, 1, 2].forEach(i => l.record(T + i * 1000));
    assert.equal(l.canRequest(T + 10_000), false);
    assert.equal(l.nextAllowed(T + 10_000), T + HOUR);
    assert.equal(l.canRequest(T + HOUR + 1), true);
    l.block(T + 5 * HOUR);
    assert.equal(l.canRequest(T + 2 * HOUR), false);
});

test('scheduler: restart at 13:15 after fetch at 13:00:01 does not fetch', () => {
    const l = new RateLimiter(3, HOUR, { log: [T + 1000] });
    const now = T + 15 * 60_000;
    const d = decide(now, { hourly: { lastOk: T + 1000, lastAttempt: T + 1000 } }, l);
    assert.deepEqual(d.run, []);
    assert.equal(d.nextAt, T + HOUR + 1000);
});

test('scheduler: fetches at HH:00:01, not before; retries after failure with backoff', () => {
    const l = new RateLimiter(3);
    const st = { hourly: { lastOk: T - HOUR + 1000, lastAttempt: T - HOUR + 1000 } };
    assert.deepEqual(decide(T, st, l).run, []);
    assert.deepEqual(decide(T + 1000, st, l).run, ['hourly']);
    const failed = { hourly: { lastOk: T - HOUR + 1000, lastAttempt: T + 1000 } };
    assert.deepEqual(decide(T + 60_000, failed, l).run, []);
    assert.deepEqual(decide(T + 11 * 60_000, failed, l).run, ['hourly']);
});

test('scheduler: never exceeds limit; 429 block respected', () => {
    const l = new RateLimiter(3, HOUR, { log: [T - 1000, T - 500] });
    const st = {
        hourly: { lastOk: 0, lastAttempt: 0 },
        month: { lastOk: 0, lastAttempt: 0 },
        year: { lastOk: 0, lastAttempt: 0 },
    };
    assert.equal(decide(T + 2000, st, l).run.length, 1);
    const b = new RateLimiter(3);
    b.block(T + HOUR);
    assert.deepEqual(decide(T + 2000, st, b).run, []);
});

const mk = (status: number, body = '{}', headers: Record<string, string> = {}): FetchFn => async () => ({
    status, ok: status < 300, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => body,
});
const params = { metrics: ['pricing'], resolution: 'hour' as const, windowStart: T };

test('client: error mapping 401/403/429/500/parse/network/timeout', async () => {
    const kind = async (f: FetchFn, ms = 50): Promise<string> =>
        new PstrykClient('k', f, ms).unified(params).then(() => 'ok', (e: PstrykError) => e.kind);
    assert.equal(await kind(mk(401)), 'auth');
    assert.equal(await kind(mk(403)), 'auth');
    assert.equal(await kind(mk(429)), 'rate_limit');
    assert.equal(await kind(mk(500)), 'http');
    assert.equal(await kind(mk(200, 'nope')), 'parse');
    assert.equal(await kind(async () => { throw new Error('ENOTFOUND'); }), 'network');
    assert.equal(await kind((_u, i) => new Promise((_r, rej) => i.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))), 'timeout');
    const e = await new PstrykClient('k', mk(429, '{}', { 'retry-after': '120' })).unified(params).catch((x: PstrykError) => x);
    assert.equal((e as PstrykError).retryAfterMs, 120_000);
});

test('client: sends key and query', async () => {
    let seen = '';
    let auth = '';
    const f: FetchFn = async (u, i) => { seen = u; auth = i.headers.Authorization; return { status: 200, ok: true, headers: { get: () => null }, text: async () => '{"frames":[]}' }; };
    await new PstrykClient('secret', f).unified({ ...params, forTz: 'Europe/Warsaw' });
    assert.equal(auth, 'secret');
    assert.match(seen, /unified-metrics\/\?metrics=pricing&resolution=hour&window_start=2026-10-23T11%3A00%3A00.000Z&for_tz=Europe%2FWarsaw/);
});

test('parse: maps known pricing fields and keeps unknown ones flat', () => {
    const { frames } = parseFrames({
        frames: [{ start: '2026-10-23T11:00:00Z', end: '2026-10-23T12:00:00Z', is_live: true, metrics: { pricing: { price_gross: 0.8, price_net: 0.65, is_cheap: true, new_field: 5 }, meterValues: { energy_balance: 1.5 } } }],
        summary: { total_cost_total: 3 },
    });
    assert.equal(frames[0].m['pricing.new_field'], 5);
    const p = toPricePoint(frames[0])!;
    assert.equal(p.buyGross, 0.8);
    assert.equal(p.isCheap, true);
    assert.equal(toPricePoint({ ...frames[0], m: { 'meterValues.x': 1 } }), null);
});

test('calc: windows, cheapest hours, analysis', () => {
    const prices = [5, 4, 1, 1, 6, 2, 9, 3];
    const slots = buildRolling(prices.map((p, i) => pt(T + i * HOUR, p)), T, 8);
    const w = cheapestWindow(slots, 2)!;
    assert.equal(w.startsInHours, 2);
    assert.equal(w.avg, 1);
    assert.deepEqual(cheapestHours(slots, 3).map(s => s.index), [2, 3, 5]);
    assert.deepEqual(cheapestHours(slots, 1, true).map(s => s.index), [6]);
    const a = analyze(slots, 15);
    assert.equal(a.availableHours, 8);
    assert.equal(a.hoursToNextCheap, 1);
    assert.equal(a.runNow, false);
    assert.equal(cheapestWindow(buildRolling([pt(T, 1)], T, 8), 2), null);
});
