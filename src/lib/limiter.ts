import { HOUR } from './time';

/** Sliding-window request limiter. Requests are recorded at start, independent of duration/outcome. */
export class RateLimiter {
    public log: number[];
    public blockedUntil: number;

    public constructor(
        public max: number,
        private readonly windowMs = HOUR,
        state?: { log?: number[]; blockedUntil?: number },
    ) {
        this.log = state?.log ? [...state.log] : [];
        this.blockedUntil = state?.blockedUntil ?? 0;
    }

    private prune(now: number): void {
        this.log = this.log.filter(t => t > now - this.windowMs && t <= now + 60_000).sort((a, b) => a - b);
    }

    public canRequest(now: number, n = 1): boolean {
        this.prune(now);
        return now >= this.blockedUntil && this.log.length + n <= this.max;
    }

    public nextAllowed(now: number, n = 1): number {
        this.prune(now);
        let t = this.blockedUntil;
        const over = this.log.length + n - this.max;
        if (over > 0) {
            t = Math.max(t, this.log[over - 1] + this.windowMs);
        }
        return Math.max(t, now);
    }

    public record(now: number): void {
        this.log.push(now);
    }

    public block(until: number): void {
        this.blockedUntil = Math.max(this.blockedUntil, until);
    }

    public toJSON(): { log: number[]; blockedUntil: number } {
        return { log: this.log, blockedUntil: this.blockedUntil };
    }
}
