import { dayStart, HOUR } from './time';
import type { Flat, Frame, PricePoint } from './types';

export function flatten(obj: unknown, prefix = '', out: Flat = {}): Flat {
    if (obj === null || obj === undefined) {
        if (prefix) {
            out[prefix] = null;
        }
    } else if (typeof obj === 'number' || typeof obj === 'boolean' || typeof obj === 'string') {
        out[prefix] = obj;
    } else if (typeof obj === 'object' && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
            flatten(v, prefix ? `${prefix}.${k}` : k, out);
        }
    }
    return out;
}

const ts = (v: unknown): number => (typeof v === 'string' ? Date.parse(v) : NaN);

export function parseFrames(resp: unknown): { frames: Frame[]; summary: Flat } {
    const r = (resp ?? {}) as { frames?: unknown; summary?: unknown };
    const frames: Frame[] = [];
    if (Array.isArray(r.frames)) {
        for (const f of r.frames as Record<string, unknown>[]) {
            const start = ts(f.start);
            const end = ts(f.end);
            if (Number.isNaN(start) || Number.isNaN(end)) {
                continue;
            }
            frames.push({ start, end, isLive: f.is_live === true, m: flatten(f.metrics) });
        }
    }
    return { frames, summary: flatten(r.summary) };
}

// field names observed in the unified-metrics `pricing` metric (same as the pstryk-ai HA integration)
const ALIASES = {
    buyGross: ['price_gross'],
    buyNet: ['price_net'],
    sellGross: ['price_prosumer_gross'],
    sellNet: ['price_prosumer_net'],
    isCheap: ['is_cheap'],
    isExpensive: ['is_expensive'],
};

function pick(m: Flat, names: string[]): number | boolean | null {
    for (const n of names) {
        for (const [k, v] of Object.entries(m)) {
            if (k.startsWith('pricing.') && k.split('.').pop() === n && v !== null && v !== '') {
                if (typeof v === 'string') {
                    const x = Number(v.replace(',', '.').trim());
                    if (Number.isFinite(x)) {
                        return x;
                    }
                    continue;
                }
                return v;
            }
        }
    }
    return null;
}

const num = (v: number | boolean | null): number | null => (typeof v === 'number' ? v : null);
const bool = (v: number | boolean | null): boolean | null => (typeof v === 'boolean' ? v : null);

/** Returns a price point only when the frame carried any pricing information. */
export function toPricePoint(f: Frame): PricePoint | null {
    if (!Object.keys(f.m).some(k => k.startsWith('pricing.') && f.m[k] !== null)) {
        return null;
    }
    const p: PricePoint = {
        start: f.start,
        end: f.end,
        buyGross: num(pick(f.m, ALIASES.buyGross)),
        buyNet: num(pick(f.m, ALIASES.buyNet)),
        sellGross: num(pick(f.m, ALIASES.sellGross)),
        sellNet: num(pick(f.m, ALIASES.sellNet)),
        isCheap: bool(pick(f.m, ALIASES.isCheap)),
        isExpensive: bool(pick(f.m, ALIASES.isExpensive)),
    };
    return p.buyGross === null && p.buyNet === null && p.sellGross === null ? null : p;
}

/**
 * Drops unpublished placeholder prices: a local day counts only when every hour has a price and
 * the prices are not (almost) all identical. Past hours of today are always kept.
 */
export function dropPlaceholderDays(points: PricePoint[], now: number): PricePoint[] {
    const byDay = new Map<number, PricePoint[]>();
    for (const p of points) {
        const d = dayStart(p.start);
        byDay.set(d, [...(byDay.get(d) ?? []), p]);
    }
    const today = dayStart(now);
    const out: PricePoint[] = [];
    for (const [day, pts] of byDay) {
        const expected = Math.round((dayStart(day, 1) - day) / HOUR);
        const vals = pts.map(p => p.buyGross ?? p.buyNet).filter((v): v is number => v !== null);
        const counts = new Map<number, number>();
        vals.forEach(v => counts.set(Math.round(v * 1e5), (counts.get(Math.round(v * 1e5)) ?? 0) + 1));
        const top = Math.max(0, ...counts.values());
        const placeholder = vals.length < expected || top / vals.length > 0.9;
        if (!placeholder) {
            out.push(...pts);
        } else if (day <= today) {
            out.push(...pts.filter(p => p.start <= now));
        }
    }
    return out.sort((a, b) => a.start - b.start);
}
