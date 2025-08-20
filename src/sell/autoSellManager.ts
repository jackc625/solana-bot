// src/sell/autoSellManager.ts
// Provides the legacy-named exports bot.ts expects: initAutoSellConfig, configureAutoSell,
// trackBuy, runAutoSellLoop. Internally uses a single watcher per position.

import { sellToken, getCurrentPriceViaJupiter } from "../core/trading.js";
import { loadBotConfig } from "../config/index.js";

type ScaleOutStep = { roi: number; fraction: number };
type TrailingTier  = { threshold: number; drop: number };

type RuntimeConfig = {
    minHoldMs: number;
    maxHoldMs: number;
    takeProfitRoi: number;
    stopLossRoi: number;
    dropFromPeakRoi: number;
    postSellCooldownMs: number;
    autoSellPollMs: number;
    scaleOut: ScaleOutStep[];
    trailing: TrailingTier[];
};

type Position = {
    mint: string;
    entryPrice: number;
    amountTokens: number;
    openedAt: number;
    peakRoi: number;
    scaleIdx: number;
    lastSellAt?: number;
};

const watchers = new Map<string, NodeJS.Timeout>();
const positions = new Map<string, Position>();
let autoSellDryRun = false;

let rc: RuntimeConfig = {
    minHoldMs: 30_000,
    maxHoldMs: 20 * 60_000,
    takeProfitRoi: 0.20,
    stopLossRoi: -0.10,
    dropFromPeakRoi: 0.25,
    postSellCooldownMs: 1500,
    autoSellPollMs: 2000,
    scaleOut: [],
    trailing: [],
};

const now = () => Date.now();
const roi = (current: number, entry: number) => (current - entry) / entry;
const tiny = (n: number) => n <= 0.000001;

function dynamicDropFromPeak(peakRoi: number) {
    let d = rc.dropFromPeakRoi;
    for (const t of rc.trailing) {
        if (peakRoi >= t.threshold && t.drop < d) d = t.drop;
    }
    return d;
}

function startWatcher(pos: Position) {
    const key = pos.mint;
    if (watchers.has(key)) return;

    const timer = setInterval(async () => {
        try {
            const quote = await getCurrentPriceViaJupiter(pos.mint, 0.01);
            if (!quote) return;
            const price = quote.price;
            const r = roi(price, pos.entryPrice);
            if (r > pos.peakRoi) pos.peakRoi = r;

            const heldMs = now() - pos.openedAt;
            const heldLongEnough = heldMs >= rc.minHoldMs;

            // Max-hold forced exit
            if (heldMs >= rc.maxHoldMs) {
                if (!tiny(pos.amountTokens) && !autoSellDryRun) {
                    try { await sellToken({ mint: pos.mint, amountTokens: pos.amountTokens }); } catch {}
                }
                clearInterval(timer);
                watchers.delete(key);
                positions.delete(key);
                return;
            }

            // Scale-outs
            if (heldLongEnough && rc.scaleOut.length > 0) {
                while (pos.scaleIdx < rc.scaleOut.length && r >= rc.scaleOut[pos.scaleIdx].roi && !tiny(pos.amountTokens)) {
                    if (pos.lastSellAt && now() - pos.lastSellAt < rc.postSellCooldownMs) break;

                    const step = rc.scaleOut[pos.scaleIdx];
                    const qty = pos.amountTokens * Math.max(0, Math.min(1, step.fraction));
                    if (!tiny(qty) && !autoSellDryRun) {
                        try {
                            await sellToken({ mint: pos.mint, amountTokens: qty });
                            pos.amountTokens -= qty;
                            pos.lastSellAt = now();
                        } catch { break; }
                    } else {
                        // dry-run: just mark as sold proportionally
                        pos.amountTokens -= qty;
                        pos.lastSellAt = now();
                    }
                    pos.scaleIdx += 1;
                }
            }

            // Core exits (full)
            const dynDrop = dynamicDropFromPeak(pos.peakRoi);
            let shouldSellAll = false;
            if (heldLongEnough && r >= rc.takeProfitRoi) shouldSellAll = true;
            else if (heldLongEnough && r <= rc.stopLossRoi) shouldSellAll = true;
            else if (heldLongEnough && pos.peakRoi !== -Infinity && pos.peakRoi - r >= dynDrop) shouldSellAll = true;

            if (shouldSellAll && !tiny(pos.amountTokens)) {
                if (!pos.lastSellAt || now() - pos.lastSellAt >= rc.postSellCooldownMs) {
                    const qty = pos.amountTokens;
                    if (!autoSellDryRun) {
                        try { await sellToken({ mint: pos.mint, amountTokens: qty }); } catch {}
                    }
                    pos.amountTokens = 0;
                    clearInterval(timer);
                    watchers.delete(key);
                    positions.delete(key);
                    return;
                }
            }

            // If depleted by scale-outs
            if (tiny(pos.amountTokens)) {
                clearInterval(timer);
                watchers.delete(key);
                positions.delete(key);
                return;
            }
        } catch { /* ignore tick errors */ }
    }, rc.autoSellPollMs);

    watchers.set(key, timer);
}

// ---------- Exports expected by bot.ts ----------

/** Load initial config from your config module */
export function initAutoSellConfig() {
    const base = loadBotConfig();
    rc = {
        minHoldMs: base.minHoldMs ?? rc.minHoldMs,
        maxHoldMs: base.maxHoldMs ?? rc.maxHoldMs,
        takeProfitRoi: base.takeProfitRoi ?? rc.takeProfitRoi,
        stopLossRoi: base.stopLossRoi ?? rc.stopLossRoi,
        dropFromPeakRoi: base.dropFromPeakRoi ?? rc.dropFromPeakRoi,
        postSellCooldownMs: base.postSellCooldownMs ?? rc.postSellCooldownMs,
        autoSellPollMs: base.autoSellPollMs ?? rc.autoSellPollMs,
        scaleOut: base.scaleOut ?? [],
        trailing: base.trailing ?? [],
    };
}

/** Allow runtime changes (legacy signature or object) */
// Overload 1: legacy (delaySeconds, dryRun?)
export function configureAutoSell(delaySeconds: number, dryRun?: boolean): void;
// Overload 2: object overrides
export function configureAutoSell(overrides: Partial<RuntimeConfig>): void;
// Impl
export function configureAutoSell(a: any, b?: any): void {
    if (typeof a === "number") {
        const delayMs = Math.max(0, Math.floor(a * 1000));
        rc.minHoldMs = delayMs;
        if (typeof b === "boolean") autoSellDryRun = b;
        return;
    }
    if (typeof a === "object" && a) {
        rc = { ...rc, ...a };
        return;
    }
}

/** Track a new buy — supports legacy call style too */
// Overload 1: legacy (mint, amountTokens, entryPrice, creator?)
export function trackBuy(mint: string, amountTokens: number, entryPrice: number, _creator?: string): void;
// Overload 2: object style
export function trackBuy(params: { mint: string; entryPrice: number; amountTokens: number }): void;
// Impl
export function trackBuy(a: any, b?: any, c?: any, _d?: any): void {
    if (typeof a === "string") {
        const mint = a as string;
        const amountTokens = Number(b) || 0;
        const entryPrice = Number(c) || 0;
        const existing = positions.get(mint);
        if (existing) {
            const total = existing.amountTokens + amountTokens;
            const newEntry =
                total > 0 ? (existing.entryPrice * existing.amountTokens + entryPrice * amountTokens) / total : existing.entryPrice;
            existing.amountTokens = total;
            existing.entryPrice = newEntry;
            // watcher already running
            return;
        }
        const pos: Position = {
            mint,
            entryPrice,
            amountTokens,
            openedAt: now(),
            peakRoi: -Infinity,
            scaleIdx: 0,
        };
        positions.set(mint, pos);
        startWatcher(pos);
        return;
    }

    // object style
    const p = a as { mint: string; entryPrice: number; amountTokens: number };
    const existing = positions.get(p.mint);
    if (existing) {
        const total = existing.amountTokens + p.amountTokens;
        const newEntry =
            total > 0
                ? (existing.entryPrice * existing.amountTokens + p.entryPrice * p.amountTokens) / total
                : existing.entryPrice;
        existing.amountTokens = total;
        existing.entryPrice = newEntry;
        return;
    }
    const pos: Position = {
        mint: p.mint,
        entryPrice: p.entryPrice,
        amountTokens: p.amountTokens,
        openedAt: now(),
        peakRoi: -Infinity,
        scaleIdx: 0,
    };
    positions.set(p.mint, pos);
    startWatcher(pos);
}

/** Legacy loop starter — watchers are interval-based, so this is a no-op kept for API compatibility. */
export function runAutoSellLoop() {
    return { watching: watchers.size, positions: positions.size, pollMs: rc.autoSellPollMs, dryRun: autoSellDryRun };
}

/** Test utility to clean up all watchers and positions */
export function __clearAllWatchers() {
    for (const timer of watchers.values()) {
        clearInterval(timer);
    }
    watchers.clear();
    positions.clear();
}
