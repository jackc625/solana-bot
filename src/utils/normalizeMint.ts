// src/utils/normalizeMint.ts
import { PublicKey } from "@solana/web3.js";

export function normalizeMint(raw: string): string | null {
    raw = raw.trim();

    // Remove trailing non-base58 garbage (e.g. bonk, pump)
    const cleaned = raw.replace(/[^1-9A-HJ-NP-Za-km-z]/g, "");

    if (cleaned.length >= 32 && cleaned.length <= 44) {
        try {
            return new PublicKey(cleaned).toBase58();
        } catch {}
    }

    // Fallback: extract valid base58 from noisy strings
    const base58Re = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    let match;
    while ((match = base58Re.exec(raw)) !== null) {
        try {
            return new PublicKey(match[0]).toBase58();
        } catch {}
    }

    return null;
}
