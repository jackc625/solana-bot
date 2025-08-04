// src/monitor/pumpFun.ts

import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import {getLpLiquidityDirectly, getLpLiquidityFromPump} from "../utils/getLpLiquidity.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";
import { getLpTokenAddress } from "../utils/getLpTokenAddress.js";
import { getJupiter } from "../utils/jupiterInstance.js";
import { normalizeMint } from "../utils/normalizeMint.js"; // ✅ IMPORTED

export interface PumpToken {
    rawData?: any;
    mint: string;
    creator: string;
    launchedAt: number;
    simulatedLp: number;
    hasJupiterRoute: boolean;
    lpTokenAddress: string;
    metadata: {
        name: string;
        symbol: string;
        decimals: number;
    };
    earlyHolders: number;
    launchSpeedSeconds: number;
}

const seenMints: Record<string, number> = {};
const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

const solMint = new PublicKey("So11111111111111111111111111111111111111112");

export const monitorPumpFun = async (onNewToken: (token: PumpToken) => void) => {
    const jupiter = await getJupiter();

    const poll = async () => {
        try {
            const res = await fetch("https://frontend-api.pump.fun/coins?offset=0&limit=50&includeNsfw=true", {
                headers: {
                    "User-Agent": "Mozilla/5.0",
                    "Accept": "application/json",
                },
            });

            const text = await res.text();

            if (!text.startsWith("[")) {
                console.warn("⚠️ Unexpected response format from pump.fun");
                return;
            }

            const data = JSON.parse(text);
            const now = Date.now();

            for (const item of data) {
                const rawMint = item.mint;
                if (!rawMint) continue;

                const mint = normalizeMint(rawMint); // ✅ CLEANING THE MINT
                if (!mint) {
                    console.warn(`❌ Skipping invalid mint: ${rawMint}`);
                    continue;
                }

                if (!seenMints[mint] || now - seenMints[mint] > SEEN_TTL_MS) {
                    seenMints[mint] = now;

                    const tokenMint = new PublicKey(mint);

                    if (!jupiter) {
                        console.warn(`⚠️ Jupiter instance unavailable for ${tokenMint}`);
                        return;
                    }

                    await new Promise((res) => setTimeout(res, 5000)); // Let Pump populate data

                    const liquidityInfo = await getLpLiquidityDirectly(mint);
                    const simulatedLp = liquidityInfo?.lpSol ?? 0;
                    const earlyHolders = liquidityInfo?.earlyHolders ?? 0;

                    const lpTokenAddress = await getLpTokenAddress(jupiter, solMint, tokenMint);
                    const hasJupiterRoute = await hasDirectJupiterRoute(jupiter, solMint, tokenMint);

                    const token: PumpToken = {
                        rawData: item,
                        mint,
                        creator: item.creatorKey || "unknown",
                        launchedAt: Math.floor(new Date(item.createdAt).getTime() / 1000),
                        simulatedLp,
                        hasJupiterRoute,
                        lpTokenAddress,
                        metadata: {
                            name: item.name,
                            symbol: item.symbol,
                            decimals: 9,
                        },
                        earlyHolders,
                        launchSpeedSeconds: item.timeToPoolCreationSeconds ?? 0,
                    };

                    console.log("🟢 Detected new pump.fun token:", token.mint);
                    console.log("🧪 Token debug:", {
                        mint,
                        simulatedLp,
                        earlyHolders,
                        lpTokenAddress,
                        hasJupiterRoute,
                    });

                    onNewToken(token);
                }
            }
        } catch (err) {
            console.error("❌ Error polling pump.fun:", err);
        }

        setTimeout(poll, 5000); // every 5 seconds
    };

    // 🧹 Clean up expired entries every 1 min
    setInterval(() => {
        const now = Date.now();
        for (const mint in seenMints) {
            if (now - seenMints[mint] > SEEN_TTL_MS) {
                delete seenMints[mint];
            }
        }
    }, 60_000);

    poll();
};
