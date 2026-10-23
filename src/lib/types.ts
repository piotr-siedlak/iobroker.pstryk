export interface PricePoint {
    start: number;
    end: number;
    buyGross: number | null;
    buyNet: number | null;
    sellGross: number | null;
    sellNet?: number | null;
    isCheap: boolean | null;
    isExpensive: boolean | null;
}

export type Flat = Record<string, number | boolean | string | null>;

export interface Frame {
    start: number;
    end: number;
    isLive: boolean;
    /** flattened metrics, keys like "pricing.price_gross" */
    m: Flat;
}
