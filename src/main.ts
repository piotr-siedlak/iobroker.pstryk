import * as utils from '@iobroker/adapter-core';
import { PstrykClient, PstrykError } from './lib/client';
import { analyze, cheapestHours, cheapestWindow, isCheap, iso } from './lib/calc';
import { RateLimiter } from './lib/limiter';
import { parseFrames, toPricePoint } from './lib/parse';
import { buildRolling } from './lib/rolling';
import { decide, type Source, type SourceState } from './lib/scheduler';
import { dayStart, floorHour, HOUR, monthStart, TZ, yearStart } from './lib/time';
import type { Flat, Frame, PricePoint } from './lib/types';

interface Cache {
    points: PricePoint[];
    frames: Frame[];
    month: Flat;
    year: Flat;
    sources: Partial<Record<Source, SourceState>>;
    limiter: { log: number[]; blockedUntil: number };
    lastError: string;
    fields: string[];
    hourlyMode: number;
}

/** Hourly request variants tried in order when the API answers HTTP 400 (docs are ambiguous). */
const HOURLY_MODES = [
    { future: true, mv: 'meter_values' },
    { future: true, mv: 'meterValues' },
    { future: false, mv: 'meter_values' },
    { future: false, mv: 'meterValues' },
];
const METRIC_GROUPS = new Set(['meterValues', 'meter_values', 'cost', 'carbon', 'pricing']);

const KEEP_MS = 4 * 24 * HOUR;
const safe = (k: string): string => k.replace(/[^A-Za-z0-9_-]/g, '_');
const group = (k: string): string =>
    /sold|export|balance/.test(k) ? 'prosumer' : /cost|vat|dist|fee|price|value/.test(k) ? 'costs' : 'energy';

class Pstryk extends utils.Adapter {
    private cache: Cache = {
        points: [], frames: [], month: {}, year: {}, sources: {},
        limiter: { log: [], blockedUntil: 0 }, lastError: '', fields: [], hourlyMode: 0,
    };
    private limiter = new RateLimiter(3);
    private timer?: NodeJS.Timeout;
    private known = new Set<string>();
    private busy = false;
    private unloading = false;

    private get cfg(): Record<string, any> {
        return this.config as unknown as Record<string, any>;
    }

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'pstryk' });
        this.on('ready', () => this.onReady());
        this.on('unload', cb => {
            this.unloading = true;
            if (this.timer) {
                clearTimeout(this.timer);
            }
            cb();
        });
    }

    private async onReady(): Promise<void> {
        const n = this.cfg;
        this.limiter = new RateLimiter(Math.min(3, Math.max(1, Number(n.maxRequestsPerHour) || 3)));
        const st = await this.getStateAsync('info.cache');
        if (st?.val) {
            try {
                this.cache = { ...this.cache, ...JSON.parse(String(st.val)) };
                this.limiter = new RateLimiter(this.limiter.max, HOUR, this.cache.limiter);
            } catch {
                this.log.warn('Cache unreadable, starting empty');
            }
        }
        this.cache.sources.hourly ??= { lastOk: 0, lastAttempt: 0 };
        if (n.fetchMonth) {
            this.cache.sources.month ??= { lastOk: 0, lastAttempt: 0 };
        } else {
            delete this.cache.sources.month;
        }
        if (n.fetchYear) {
            this.cache.sources.year ??= { lastOk: 0, lastAttempt: 0 };
        } else {
            delete this.cache.sources.year;
        }
        await this.loop();
    }

    private async loop(): Promise<void> {
        if (this.busy || this.unloading) {
            return;
        }
        this.busy = true;
        let nextAt = Infinity;
        try {
            const now = Date.now();
            await this.render(now);
            const d = decide(Date.now(), this.cache.sources, this.limiter);
            if (d.run.length) {
                for (const src of d.run) {
                    if (this.unloading) {
                        break;
                    }
                    await this.fetchSource(src);
                }
                await this.render(Date.now());
                nextAt = decide(Date.now(), this.cache.sources, this.limiter).nextAt;
            } else {
                nextAt = d.nextAt;
            }
        } catch (e) {
            this.log.error(`Loop error: ${(e as Error).message}`);
        }
        this.busy = false;
        if (this.unloading) {
            return;
        }
        const now = Date.now();
        const boundary = floorHour(now) + HOUR;
        const at = Math.min(nextAt, boundary);
        await this.put('info.next_update', Number.isFinite(nextAt) ? new Date(nextAt).toISOString() : '', { type: 'string', role: 'date', name: 'Next API fetch' });
        this.timer = setTimeout(() => void this.loop(), Math.max(500, at - now));
    }

    private async fetchSource(src: Source): Promise<void> {
        const key = String(this.cfg.apiKey ?? '');
        const st = this.cache.sources[src]!;
        const now = Date.now();
        st.lastAttempt = now;
        if (!key) {
            this.cache.lastError = 'API key not configured';
            await this.persist();
            return;
        }
        this.limiter.record(now);
        const client = new PstrykClient(key);
        try {
            const mode = HOURLY_MODES[this.cache.hourlyMode] ?? HOURLY_MODES[0];
            const resp =
                src === 'hourly'
                    ? await client.unified({ metrics: ['pricing', mode.mv, 'cost'], resolution: 'hour', windowStart: dayStart(now, -1), windowEnd: mode.future ? dayStart(now, 2) : undefined })
                    : await client.unified({
                          metrics: [mode.mv, 'cost'],
                          resolution: src === 'month' ? 'day' : 'month',
                          windowStart: src === 'month' ? monthStart(now) : yearStart(now),
                          windowEnd: now,
                          forTz: TZ,
                      });
            const { frames, summary } = parseFrames(resp);
            if (src === 'hourly') {
                this.mergeHourly(frames, now);
                await this.put('raw.unified_metrics', JSON.stringify(resp), { type: 'string', role: 'json', name: 'Last raw unified-metrics response' });
            } else {
                this.cache[src] = summary;
            }
            const keys = new Set(this.cache.fields);
            frames.forEach(f => Object.keys(f.m).forEach(k => keys.add(k)));
            Object.keys(summary).forEach(k => keys.add(`summary.${k}`));
            this.cache.fields = [...keys].sort();
            st.lastOk = now;
            this.cache.lastError = '';
            await this.put('info.auth_error', false, { type: 'boolean', role: 'indicator.error', name: 'API key rejected' });
            await this.put('info.connection', true, { type: 'boolean', role: 'indicator.connected', name: 'Connected' });
            await this.put('info.last_update', new Date(now).toISOString(), { type: 'string', role: 'date', name: 'Last successful update' });
        } catch (e) {
            const err = e as PstrykError;
            this.cache.lastError = `${src}: ${err.kind ?? 'error'}: ${err.message}`;
            if (err.kind === 'rate_limit') {
                this.limiter.block(now + (err.retryAfterMs ?? HOUR));
            }
            if (err.kind === 'auth') {
                this.limiter.block(now + HOUR);
                await this.put('info.auth_error', true, { type: 'boolean', role: 'indicator.error', name: 'API key rejected' });
            }
            if (err.kind === 'http' && err.status === 400 && this.cache.hourlyMode < HOURLY_MODES.length - 1) {
                this.cache.hourlyMode++;
                this.log.warn(`HTTP 400, switching request variant to ${JSON.stringify(HOURLY_MODES[this.cache.hourlyMode])}`);
            }
            this.log.warn(this.cache.lastError);
            await this.put('info.connection', false, { type: 'boolean', role: 'indicator.connected', name: 'Connected' });
        }
        await this.persist();
    }

    private mergeHourly(frames: Frame[], now: number): void {
        const pts = new Map(this.cache.points.map(p => [p.start, p]));
        for (const f of frames) {
            const p = toPricePoint(f);
            if (p) {
                pts.set(p.start, p);
            }
        }
        const fr = new Map(this.cache.frames.map(f => [f.start, f]));
        for (const f of frames) {
            fr.set(f.start, { ...f, m: Object.fromEntries(Object.entries(f.m).filter(([k]) => !k.startsWith('pricing.'))) });
        }
        this.cache.points = [...pts.values()].filter(p => p.start > now - KEEP_MS).sort((a, b) => a.start - b.start);
        this.cache.frames = [...fr.values()].filter(f => f.start > now - KEEP_MS).sort((a, b) => a.start - b.start);
    }

    private async persist(): Promise<void> {
        this.cache.limiter = this.limiter.toJSON();
        await this.put('info.cache', JSON.stringify(this.cache), { type: 'string', role: 'json', name: 'Persistent cache' });
        await this.put('info.api_requests', this.limiter.log.length, { type: 'number', role: 'value', name: 'API requests in last hour' });
        await this.put('info.last_error', this.cache.lastError, { type: 'string', role: 'text', name: 'Last error' });
    }

    private async put(id: string, val: any, common: Partial<ioBroker.StateCommon>): Promise<void> {
        if (!this.known.has(id)) {
            await this.setObjectNotExistsAsync(id, {
                type: 'state',
                common: { name: id, read: true, write: false, type: 'string', role: 'state', ...common } as ioBroker.StateCommon,
                native: {},
            });
            this.known.add(id);
        }
        await this.setStateChangedAsync(id, { val, ack: true });
    }

    private async render(now: number): Promise<void> {
        const unit = String(this.cfg.priceUnit || '');
        const thrRaw = Number(this.cfg.cheapThresholdPct);
        const thr = Number.isFinite(thrRaw) && this.cfg.cheapThresholdPct !== '' ? thrRaw : 15;
        const win = Number(this.cfg.chargeWindowHours) || 4;
        const slots = buildRolling(this.cache.points, now);
        const a = analyze(slots, thr);
        const pc = (name: string, role = 'value.price'): Partial<ioBroker.StateCommon> => ({ type: 'number', role, unit, name });
        const bc = (name: string): Partial<ioBroker.StateCommon> => ({ type: 'boolean', role: 'indicator', name });
        const sc = (name: string): Partial<ioBroker.StateCommon> => ({ type: 'string', role: 'date', name });

        const writeSlot = async (base: string, s: (typeof slots)[number]): Promise<void> => {
            const p = s.point;
            await this.put(`${base}.buy_gross`, p?.buyGross ?? null, pc('Buy price gross'));
            await this.put(`${base}.buy_net`, p?.buyNet ?? null, pc('Buy price net'));
            await this.put(`${base}.sell_gross`, p?.sellGross ?? null, pc('Sell price gross'));
            await this.put(`${base}.is_cheap`, p ? isCheap(s, a.avg, thr) : null, bc('Is cheap'));
            await this.put(`${base}.is_expensive`, p ? (p.isExpensive ?? (a.avg !== null && (p.buyGross ?? p.buyNet) !== null && (p.buyGross ?? p.buyNet)! >= a.avg * (1 + thr / 100))) : null, bc('Is expensive'));
            await this.put(`${base}.start_time`, iso(s.start), sc('Start'));
            await this.put(`${base}.end_time`, iso(s.end), sc('End'));
            await this.put(`${base}.available`, p !== null, bc('Price available'));
        };
        for (const s of slots) {
            await writeSlot(`prices.rolling.${String(s.index).padStart(2, '0')}`, s);
        }
        await writeSlot('prices.current', slots[0]);
        await writeSlot('prices.next', slots[1]);

        // statistics of the rolling horizon
        await this.put('prices.statistics.avg', a.avg, pc('Average price (known rolling hours)'));
        await this.put('prices.statistics.min', a.min, pc('Minimum price'));
        await this.put('prices.statistics.max', a.max, pc('Maximum price'));
        await this.put('prices.statistics.available_hours', a.availableHours, { type: 'number', role: 'value', name: 'Hours with known price' });
        await this.put('prices.statistics.diff_to_avg', a.diffToAvg, pc('Current price minus average'));
        await this.put('prices.statistics.attractiveness_pct', a.attractivenessPct, { type: 'number', role: 'value', unit: '%', name: 'Attractiveness (% below average)' });
        await this.put('prices.statistics.hours_to_next_cheap', a.hoursToNextCheap, { type: 'number', role: 'value', unit: 'h', name: 'Hours to next cheap hour' });
        await this.put('prices.statistics.run_now', a.runNow, bc('Run consumer now'));

        // absolute + day views
        const dayView = async (name: string, from: number): Promise<void> => {
            const pts = this.cache.points.filter(p => p.start >= from && p.start < dayStart(from, 1));
            const v = pts.map(p => p.buyGross ?? p.buyNet).filter((x): x is number => x !== null);
            await this.put(`prices.${name}.json`, JSON.stringify(pts), { type: 'string', role: 'json', name: `Prices ${name}` });
            await this.put(`prices.${name}.hours`, pts.length, { type: 'number', role: 'value', name: 'Hours known' });
            await this.put(`prices.${name}.min`, v.length ? Math.min(...v) : null, pc('Min'));
            await this.put(`prices.${name}.max`, v.length ? Math.max(...v) : null, pc('Max'));
            await this.put(`prices.${name}.avg`, v.length ? v.reduce((x, y) => x + y, 0) / v.length : null, pc('Avg'));
        };
        await dayView('today', dayStart(now));
        await dayView('tomorrow', dayStart(now, 1));
        await this.put('prices.absolute.json', JSON.stringify(this.cache.points), { type: 'string', role: 'json', name: 'All cached prices with real timestamps' });

        for (const n of [2, 3, 4, 6, 8]) {
            const w = cheapestWindow(slots, n);
            const b = `cheapest_hours.consecutive_${n}`;
            await this.put(`${b}.start`, w ? iso(w.start) : null, sc('Window start'));
            await this.put(`${b}.end`, w ? iso(w.end) : null, sc('Window end'));
            await this.put(`${b}.avg_price`, w?.avg ?? null, pc('Average price'));
            await this.put(`${b}.starts_in_hours`, w?.startsInHours ?? null, { type: 'number', role: 'value', unit: 'h', name: 'Starts in' });
            const hrs = cheapestHours(slots, n);
            await this.put(`cheapest_hours.any_${n}`, JSON.stringify(hrs.map(h => ({ start: iso(h.start), price: h.point?.buyGross ?? h.point?.buyNet }))), { type: 'string', role: 'json', name: `Cheapest ${n} hours (any)` });
            const ex = cheapestHours(slots, n, true);
            await this.put(`most_expensive_hours.any_${n}`, JSON.stringify(ex.map(h => ({ start: iso(h.start), price: h.point?.buyGross ?? h.point?.buyNet }))), { type: 'string', role: 'json', name: `Most expensive ${n} hours` });
        }
        const cw = cheapestWindow(slots, win);
        await this.put('prices.best_charge_window.start', cw ? iso(cw.start) : null, sc('Best charge window start'));
        await this.put('prices.best_charge_window.end', cw ? iso(cw.end) : null, sc('Best charge window end'));
        await this.put('prices.best_charge_window.active', cw ? now >= cw.start && now < cw.end : null, bc('Charge window active now'));

        await this.renderEnergy(now);

        const okTs = this.cache.sources.hourly?.lastOk ?? 0;
        await this.put('info.data_stale', !okTs || now - okTs > 2 * HOUR || slots[0].point === null, bc('Data stale'));
        await this.put('raw.available_api_fields', JSON.stringify(this.cache.fields), { type: 'string', role: 'json', name: 'API fields seen' });
        await this.persist();
    }

    private async renderEnergy(now: number): Promise<void> {
        const sumRange = (from: number, to: number): Flat => {
            const out: Record<string, number> = {};
            for (const f of this.cache.frames) {
                if (f.start >= from && f.start < to) {
                    for (const [k, v] of Object.entries(f.m)) {
                        if (typeof v === 'number') {
                            out[k] = (out[k] ?? 0) + v;
                        }
                    }
                }
            }
            return out;
        };
        const write = async (period: string, data: Flat): Promise<void> => {
            for (const [k, v] of Object.entries(data)) {
                if (typeof v !== 'number') {
                    continue;
                }
                const parts = k.split('.');
                const key = safe((METRIC_GROUPS.has(parts[0]) && parts.length > 1 ? parts.slice(1) : parts).join('_'));
                await this.put(`${group(key)}.${period}.${key}`, v, { type: 'number', role: 'value', name: k });
            }
        };
        const hour = floorHour(now);
        const cur = this.cache.frames.find(f => f.start === hour) ?? [...this.cache.frames].reverse().find(f => f.start <= hour);
        if (cur) {
            await write('current', cur.m);
        }
        await write('today', sumRange(dayStart(now), dayStart(now, 1)));
        await write('yesterday', sumRange(dayStart(now, -1), dayStart(now)));
        await write('month', this.cache.month);
        await write('year', this.cache.year);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Pstryk(options);
} else {
    (() => new Pstryk())();
}
