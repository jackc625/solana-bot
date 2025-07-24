import { Jupiter, RouteInfo } from "@jup-ag/core";
import { PublicKey } from "@solana/web3.js";
import * as JSBI from "jsbi";
import { connection } from "./solana.js";
import { loadBotConfig } from "../config/index.js";
import PQueueModule from "p-queue";
import { shouldCooldown, triggerCooldown } from "./globalCooldown.js";

const PQueue = (PQueueModule as any).default ?? PQueueModule;
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const config = loadBotConfig();

const jupiterCache = new Map<string, Jupiter>();

async function getSharedJupiter(user: PublicKey): Promise<Jupiter> {
    const key = user.toBase58();

    if (jupiterCache.has(key)) return jupiterCache.get(key)!;

    const instance = await Jupiter.load({
        connection,
        cluster: "mainnet-beta",
        user,
    });

    jupiterCache.set(key, instance);
    return instance;
}

// TTL cache to avoid duplicate swap requests
const recentQuotes = new Map<string, number>();
const TTL_MS = 10_000; // 10 seconds

setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of recentQuotes.entries()) {
        if (now - timestamp > TTL_MS) {
            recentQuotes.delete(key);
        }
    }
}, 60_000); // Run every 60 seconds

const jupiterQueue = new PQueue({
    interval: 1000,
    intervalCap: 10,
    carryoverConcurrencyCount: true,
});

let consecutive429s = 0;
let consecutiveFails = 0;
let lastCooldown = 0;

export async function computeSwap(
    outputMint: string,
    amount: number,
    userPublicKey: PublicKey
): Promise<RouteInfo | null> {
    if (shouldCooldown()) {
        console.warn("🛑 Skipping Jupiter call — global cooldown active.");
        return null;
    }

    const dedupKey = `${outputMint}:${amount.toFixed(4)}`;
    const now = Date.now();
    if (recentQuotes.has(dedupKey) && now - recentQuotes.get(dedupKey)! < TTL_MS) {
        console.warn(`🧠 Skipping duplicate Jupiter computeSwap for ${dedupKey}`);
        return null;
    }
    recentQuotes.set(dedupKey, now);

    try {
        const now = Date.now();

        if (now - lastCooldown < 10_000) {
            console.warn("⏳ Global cooldown active... waiting");
            await new Promise((r) => setTimeout(r, 2000));
        }

        console.log(`📡 Jupiter queue size: ${jupiterQueue.size}`); // Add this before each jupiterQueue.add()
        console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

        const result = await jupiterQueue.add(async () => {
            console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

            console.log(`📡 Jupiter API hit at ${new Date().toISOString()}`);


            if (consecutive429s >= 5 || consecutiveFails >= 2) {
                triggerCooldown(15_000);
                const wait = 5000 + consecutiveFails * 2000;
                console.warn(
                    `⏳ Cooling down after ${consecutive429s} 429s and ${consecutiveFails} fails... waiting ${wait}ms`
                );
                await new Promise((res) => setTimeout(res, wait));
                lastCooldown = Date.now();
            }

            const jupiter = await getSharedJupiter(userPublicKey);

            const rawResult = await jupiter.computeRoutes({
                inputMint: SOL_MINT,
                outputMint: new PublicKey(outputMint),
                amount: (JSBI as any).BigInt(Math.floor(amount * 1e9)),
                slippageBps: config.slippage * 100,
            });

            const routeInfos = (rawResult as any)?.routesInfos;
            consecutive429s = 0;
            consecutiveFails = 0;
            return routeInfos?.[0] ?? null;
        });

        return result;
    } catch (err: any) {
        const msg = err?.message || err?.toString() || "";

        if (msg.includes("429") || msg.includes("Too Many Requests")) {
            consecutive429s += 1;
            console.warn(`⚠️  Jupiter 429 (${consecutive429s}x)`);
        } else if (msg.includes("Assertion failed")) {
            consecutiveFails += 1;
            if (consecutiveFails >= 3) {
                triggerCooldown(15_000);
            }
            console.warn(`⚠️  Jupiter internal error: Assertion failed (${consecutiveFails}x)`);

            if (consecutiveFails >= 5) {
                console.warn("🚫 Too many internal Jupiter errors — entering extended cooldown...");
                await new Promise((r) => setTimeout(r, 20_000));
                lastCooldown = Date.now();
            }
        } else {
            console.error("❌ Jupiter route fetch failed:", msg);
        }

        return null;
    }
}

export async function getLpLiquidity(
    jupiter: Jupiter,
    inputMint: string,
    outputMint: string,
    amountInSol = 0.1
): Promise<number | null> {
    try {
        console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

        const result = await jupiterQueue.add(async () => {
            console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

            console.log(`🔁 [getLpLiquidity] Simulating LP for ${inputMint} → ${outputMint}`);

            const routes = await jupiter.computeRoutes({
                inputMint: new PublicKey(inputMint),
                outputMint: new PublicKey(outputMint),
                amount: (JSBI as any).BigInt(Math.floor(amountInSol * 1e9)),
                slippageBps: 50,
            });

            const best = routes.routesInfos?.[0];
            if (!best || !best.outAmount) return null;

            return Number(best.outAmount.toString()) / 1e9;
        });

        return result;
    } catch (e) {
        console.error(`❌ getLpLiquidity failed for ${outputMint}:`, e);
        return null;
    }
}

export async function simulateSell({
                                       tokenMint,
                                       tokenAmount,
                                       userPubkey
                                   }: {
    tokenMint: string;
    tokenAmount: number;
    userPubkey: PublicKey;
}): Promise<{ expectedOut: number; success: boolean }> {
    if (shouldCooldown()) {
        console.warn("🛑 Skipping sell simulation — cooldown active.");
        return { expectedOut: 0, success: false };
    }

    const key = `${tokenMint}:${tokenAmount}`;
    const now = Date.now();
    if (recentQuotes.has(key) && now - recentQuotes.get(key)! < TTL_MS) {
        console.warn(`🌀 Skipping duplicate simulation for ${key}`);
        return { expectedOut: 0, success: false };
    }
    recentQuotes.set(key, now);

    try {
        console.log(`📡 Jupiter queue size: ${jupiterQueue.size}`); // Add this before each jupiterQueue.add()


        console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

        const result = await jupiterQueue.add(async () => {
            console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

            const jupiter = await getSharedJupiter(userPubkey)

            const route = await jupiter.computeRoutes({
                inputMint: new PublicKey(tokenMint),
                outputMint: SOL_MINT,
                amount: (JSBI as any).BigInt(Math.floor(tokenAmount * 1e9)),
                slippageBps: config.slippage * 100,
            });

            const info = route.routesInfos?.[0];
            const expectedOut = info?.outAmount ? Number(info.outAmount.toString()) / 1e9 : 0;

            return {
                expectedOut,
                success: expectedOut > 0
            };
        });

        return result;
    } catch (err) {
        console.warn(`❌ Sell simulation failed for ${tokenMint}:`, (err as Error)?.message || err);
        return { expectedOut: 0, success: false };
    }
}

export { jupiterQueue };
export { getSharedJupiter };
