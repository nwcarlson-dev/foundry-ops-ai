/**
 * Deterministic RNG so `npm run seed` reproduces byte-identical data from a
 * fixed seed. Hand-rolled mulberry32 rather than a dependency — it is nine
 * lines and the whole point is that we control the sequence.
 */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export class Rng {
    private next: () => number;

    constructor(seed: number) {
        this.next = mulberry32(seed);
    }

    /** Uniform float in [0, 1). */
    float(): number {
        return this.next();
    }

    /** Uniform float in [min, max). */
    range(min: number, max: number): number {
        return min + this.next() * (max - min);
    }

    /** Uniform integer in [min, max] inclusive. */
    int(min: number, max: number): number {
        return Math.floor(this.range(min, max + 1));
    }

    /** Approximately normal via Box-Muller, clamped to +/- 3 sigma. */
    normal(mean: number, stdDev: number): number {
        const u1 = Math.max(this.next(), 1e-9);
        const u2 = this.next();
        const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return mean + stdDev * Math.max(-3, Math.min(3, z));
    }

    /** True with the given probability. */
    chance(probability: number): boolean {
        return this.next() < probability;
    }

    pick<T>(items: readonly T[]): T {
        return items[this.int(0, items.length - 1)];
    }

    /** Weighted pick. Weights need not sum to 1. */
    weighted<T>(entries: readonly (readonly [T, number])[]): T {
        const total = entries.reduce((sum, [, w]) => sum + w, 0);
        let roll = this.next() * total;
        for (const [value, weight] of entries) {
            roll -= weight;
            if (roll <= 0) return value;
        }
        return entries[entries.length - 1][0];
    }

    shuffle<T>(items: T[]): T[] {
        const out = [...items];
        for (let i = out.length - 1; i > 0; i--) {
            const j = this.int(0, i);
            [out[i], out[j]] = [out[j], out[i]];
        }
        return out;
    }
}
