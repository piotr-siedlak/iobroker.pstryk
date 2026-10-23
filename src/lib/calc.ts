import { HOUR } from './time';
import type { Slot } from './rolling';

export interface Window {
    start: number;
    end: number;
    hours: number;
    avg: number;
    total: number;
    startsInHours: number;
}

const price = (s: Slot): number | null => s.point?.buyGross ?? s.point?.buyNet ?? null;

export function cheapestWindow(slots: Slot[], n: number): Window | null {
    let best: Window | null = null;
    for (let i = 0; i + n <= slots.length; i++) {
        let sum = 0;
        let ok = true;
        for (let j = i; j < i + n; j++) {
            const p = price(slots[j]);
            if (p === null) {
                ok = false;
                break;
            }
            sum += p;
        }
        if (ok && (!best || sum < best.total)) {
            best = { start: slots[i].start, end: slots[i + n - 1].end, hours: n, avg: sum / n, total: sum, startsInHours: i };
        }
    }
    return best;
}

/** Cheapest n hours, not necessarily consecutive, sorted chronologically. */
export function cheapestHours(slots: Slot[], n: number, expensive = false): Slot[] {
    const avail = slots.filter(s => price(s) !== null);
    avail.sort((a, b) => (expensive ? price(b)! - price(a)! : price(a)! - price(b)!) || a.start - b.start);
    return avail.slice(0, n).sort((a, b) => a.start - b.start);
}

export interface Analysis {
    avg: number | null;
    min: number | null;
    max: number | null;
    availableHours: number;
    current: number | null;
    diffToAvg: number | null;
    attractivenessPct: number | null;
    hoursToNextCheap: number | null;
    runNow: boolean | null;
}

export function isCheap(slot: Slot, avg: number | null, thresholdPct: number): boolean {
    if (slot.point?.isCheap !== null && slot.point?.isCheap !== undefined) {
        return slot.point.isCheap;
    }
    const p = price(slot);
    return p !== null && avg !== null && p <= avg * (1 - thresholdPct / 100);
}

export function analyze(slots: Slot[], thresholdPct: number): Analysis {
    const prices = slots.map(price).filter((p): p is number => p !== null);
    const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    const current = price(slots[0]);
    let hoursToNextCheap: number | null = null;
    for (let i = 0; i < slots.length; i++) {
        if (price(slots[i]) !== null && isCheap(slots[i], avg, thresholdPct)) {
            hoursToNextCheap = i;
            break;
        }
    }
    const diff = current !== null && avg !== null ? current - avg : null;
    // run now if cheap now, or no cheaper-than-now hour is known to come (cheap == lowest known in horizon)
    const cheapNow = current !== null ? isCheap(slots[0], avg, thresholdPct) : null;
    const minKnown = prices.length ? Math.min(...prices) : null;
    return {
        avg,
        min: minKnown,
        max: prices.length ? Math.max(...prices) : null,
        availableHours: prices.length,
        current,
        diffToAvg: diff,
        attractivenessPct: diff !== null && avg ? (-diff / Math.abs(avg)) * 100 : null,
        hoursToNextCheap,
        runNow: cheapNow === null ? null : cheapNow || (current !== null && minKnown !== null && current <= minKnown),
    };
}

export const iso = (ms: number): string => new Date(ms).toISOString();
export { HOUR };
