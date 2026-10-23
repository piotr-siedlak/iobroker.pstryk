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

const ALIASES = {
    buyGross: ['price_gross', 'full_price', 'price_with_vat', 'buy_gross', 'price'],
    buyNet: ['price_net', 'price_netto', 'buy_net'],
    sellGross: ['price_prosumer_gross', 'price_prosumer', 'prosumer_price', 'sell_gross', 'price_sell', 'sell_price'],
    isCheap: ['is_cheap'],
    isExpensive: ['is_expensive'],
};

function pick(m: Flat, names: string[]): number | boolean | null {
    for (const n of names) {
        for (const [k, v] of Object.entries(m)) {
            if (k.startsWith('pricing.') && k.split('.').pop() === n && v !== null && typeof v !== 'string') {
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
        isCheap: bool(pick(f.m, ALIASES.isCheap)),
        isExpensive: bool(pick(f.m, ALIASES.isExpensive)),
    };
    return p.buyGross === null && p.buyNet === null && p.sellGross === null ? null : p;
}
