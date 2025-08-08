// src/utils/normalizeMint.ts
import { PublicKey } from "@solana/web3.js";

/**
 * If raw ends with the pool name, strip that suffix;
 * then try to turn it into a PublicKey. If valid, return
 * its canonical Base58 string.
 */
export function normalizeMint(raw: string, pool: string): string | null {
    let cleaned = raw.trim();

    if (cleaned.toLowerCase().endsWith(pool.toLowerCase())) {
        cleaned = cleaned.slice(0, cleaned.length - pool.length);
    }

    try {
        // will throw if cleaned isn’t exactly 32 bytes after Base58-decoding
        const pk = new PublicKey(cleaned);
        return pk.toBase58();
    } catch {
        return null;
    }
}
