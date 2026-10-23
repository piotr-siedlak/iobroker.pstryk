export const HOUR = 3_600_000;
export const TZ = 'Europe/Warsaw';

export function floorHour(ms: number): number {
    return Math.floor(ms / HOUR) * HOUR;
}

function tzOffsetMs(ms: number, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(ms));
    const g = (t: string): number => Number(parts.find(p => p.type === t)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of local midnight of the day containing `ms` (+ `addDays` calendar days). */
export function dayStart(ms: number, addDays = 0, tz = TZ): number {
    const local = new Date(ms + tzOffsetMs(ms, tz));
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays);
    let guess = wall - tzOffsetMs(wall, tz);
    guess = wall - tzOffsetMs(guess, tz);
    return guess;
}

export function monthStart(ms: number, tz = TZ): number {
    const local = new Date(ms + tzOffsetMs(ms, tz));
    const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
    return wall - tzOffsetMs(wall - tzOffsetMs(wall, tz), tz);
}

export function yearStart(ms: number, tz = TZ): number {
    const local = new Date(ms + tzOffsetMs(ms, tz));
    const wall = Date.UTC(local.getUTCFullYear(), 0, 1);
    return wall - tzOffsetMs(wall - tzOffsetMs(wall, tz), tz);
}
