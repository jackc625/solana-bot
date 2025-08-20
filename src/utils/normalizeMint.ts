// src/utils/normalizeMint.ts
import { PublicKey } from "@solana/web3.js";

/**
 * Safer normalization: only strip pool suffixes when a clear delimiter is present.
 * For curve pools you should skip calling this function entirely.
 */
export function normalizeMint(raw: string, pool: string): string | null {
    const cleaned = (raw || "").trim();
    if (!cleaned) return null;

    const trySplit = (sep: string) => {
        if (!cleaned.includes(sep)) return null;
        const [mint, suffix] = cleaned.split(sep, 2);
        if (suffix === pool) return mint;
        return null;
    };

    const candidate = trySplit("|") ?? trySplit(":") ?? cleaned;

    try {
        const pk = new PublicKey(candidate);
        return pk.toBase58();
    } catch {
        return null;
    }
}
