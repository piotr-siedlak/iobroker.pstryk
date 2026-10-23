import { floorHour, HOUR } from './time';
import type { PricePoint } from './types';

export interface Slot {
    index: number;
    start: number;
    end: number;
    point: PricePoint | null;
}

/** Builds 24 slots from real timestamps; missing hours stay null (never shifted blindly). */
export function buildRolling(points: Iterable<PricePoint>, now: number, size = 24): Slot[] {
    const byStart = new Map<number, PricePoint>();
    for (const p of points) {
        byStart.set(p.start, p);
    }
    const base = floorHour(now);
    const slots: Slot[] = [];
    for (let i = 0; i < size; i++) {
        const start = base + i * HOUR;
        slots.push({ index: i, start, end: start + HOUR, point: byStart.get(start) ?? null });
    }
    return slots;
}
