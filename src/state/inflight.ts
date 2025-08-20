// src/state/inflight.ts
const inflight = new Set<string>();

function key(mint: string, side: "buy" | "sell") {
    return `${mint}:${side}`;
}

export function begin(mint: string, side: "buy" | "sell"): boolean {
    const k = key(mint, side);
    if (inflight.has(k)) return false;
    inflight.add(k);
    return true;
}

export function end(mint: string, side: "buy" | "sell"): void {
    inflight.delete(key(mint, side));
}

export function isInflight(mint: string, side: "buy" | "sell"): boolean {
    return inflight.has(key(mint, side));
}
