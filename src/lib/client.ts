export type ErrorKind = 'auth' | 'rate_limit' | 'timeout' | 'network' | 'http' | 'parse';

export class PstrykError extends Error {
    public constructor(
        public readonly kind: ErrorKind,
        message: string,
        public readonly status?: number,
        public readonly retryAfterMs?: number,
    ) {
        super(message);
    }
}

export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
    status: number;
    ok: boolean;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}>;

export interface UnifiedParams {
    metrics: string[];
    resolution: 'hour' | 'day' | 'month' | 'minute';
    windowStart: number;
    windowEnd?: number;
    forTz?: string;
}

const z = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export class PstrykClient {
    public constructor(
        private readonly apiKey: string,
        private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
        private readonly timeoutMs = 20_000,
        private readonly baseUrl = 'https://api.pstryk.pl',
    ) {}

    public async unified(p: UnifiedParams): Promise<unknown> {
        const q = new URLSearchParams({
            metrics: p.metrics.join(','),
            resolution: p.resolution,
            window_start: z(p.windowStart),
        });
        if (p.windowEnd) {
            q.set('window_end', z(p.windowEnd));
        }
        if (p.forTz) {
            q.set('for_tz', p.forTz);
        }
        const url = `${this.baseUrl}/integrations/meter-data/unified-metrics/?${q}`;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
        try {
            const res = await this.fetchFn(url, { headers: { Authorization: this.apiKey, Accept: 'application/json' }, signal: ctl.signal });
            if (res.status === 401 || res.status === 403) {
                throw new PstrykError('auth', `Authorization failed (HTTP ${res.status})`, res.status);
            }
            if (res.status === 429) {
                const ra = Number(res.headers.get('retry-after'));
                throw new PstrykError('rate_limit', 'Rate limit exceeded (HTTP 429)', 429, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
            }
            if (!res.ok) {
                throw new PstrykError('http', `HTTP ${res.status}`, res.status);
            }
            const body = await res.text();
            try {
                return JSON.parse(body);
            } catch {
                throw new PstrykError('parse', 'Invalid JSON in response');
            }
        } catch (e) {
            if (e instanceof PstrykError) {
                throw e;
            }
            const err = e as { name?: string; message?: string };
            if (err.name === 'AbortError' || err.name === 'TimeoutError') {
                throw new PstrykError('timeout', `Timeout after ${this.timeoutMs} ms`);
            }
            throw new PstrykError('network', err.message ?? 'Network error');
        } finally {
            clearTimeout(timer);
        }
    }
}
