import { floorHour, HOUR } from './time';
import type { RateLimiter } from './limiter';

export type Source = 'hourly' | 'month' | 'year';

export interface SourceState {
    lastOk: number;
    lastAttempt: number;
}

export const MIN_INTERVAL: Record<Source, number> = { hourly: HOUR, month: 6 * HOUR, year: 12 * HOUR };
export const RETRY_MS = 10 * 60_000;
export const FETCH_DELAY_MS = 1000;

function dueAt(src: Source, st: SourceState, now: number): number {
    if (src === 'hourly') {
        const hour = floorHour(now);
        const okThisHour = st.lastOk > 0 && floorHour(st.lastOk) >= hour;
        let t = okThisHour ? hour + HOUR + FETCH_DELAY_MS : hour + FETCH_DELAY_MS;
        if (!okThisHour && st.lastAttempt > st.lastOk && st.lastAttempt >= hour) {
            t = Math.max(t, st.lastAttempt + RETRY_MS);
        }
        return t;
    }
    let t = st.lastOk ? st.lastOk + MIN_INTERVAL[src] : 0;
    if (st.lastAttempt > st.lastOk) {
        t = Math.max(t, st.lastAttempt + RETRY_MS);
    }
    return t;
}

/** Decides which sources to fetch now and when to look again. Pure function. */
export function decide(
    now: number,
    states: Partial<Record<Source, SourceState>>,
    limiter: RateLimiter,
): { run: Source[]; nextAt: number } {
    const run: Source[] = [];
    let nextAt = Infinity;
    let used = 0;
    for (const src of ['hourly', 'month', 'year'] as Source[]) {
        const st = states[src];
        if (!st) {
            continue;
        }
        const due = dueAt(src, st, now);
        if (due <= now && limiter.canRequest(now, used + 1)) {
            run.push(src);
            used++;
        } else {
            nextAt = Math.min(nextAt, Math.max(due, limiter.nextAllowed(now, used + 1)));
        }
    }
    return { run, nextAt };
}
