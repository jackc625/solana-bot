// src/monitor/pumpFun.ts

import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import { Jupiter } from "@jup-ag/core";
import { getLpLiquidity } from "../utils/jupiter.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";
import { getLpTokenAddress } from "../utils/getLpTokenAddress.js";
import { getJupiter } from "../utils/jupiterInstance.js";

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
            console.log("🔍 Raw response:\n", text);

            const data = JSON.parse(text);
            const now = Date.now();

            for (const item of data) {
                const mint = item.mint;
                if (!mint) continue;

                if (!seenMints[mint] || now - seenMints[mint] > SEEN_TTL_MS) {
                    seenMints[mint] = now;

                    const tokenMint = new PublicKey(mint);

                    const hasJupiterRoute = await hasDirectJupiterRoute(jupiter, solMint, tokenMint);
                    const lpTokenAddress = await getLpTokenAddress(jupiter, solMint, tokenMint);
                    const simulatedLp = await getLpLiquidity(jupiter, solMint.toBase58(), mint) ?? 0;

                    const token: PumpToken = {
                        rawData: item,
                        mint,
                        creator: item.creatorKey || "unknown",
                        launchedAt: new Date(item.createdAt).getTime(),
                        simulatedLp,
                        hasJupiterRoute,
                        lpTokenAddress,
                        metadata: {
                            name: item.name,
                            symbol: item.symbol,
                            decimals: 9,
                        },
                        earlyHolders: item.earlyBuyerCount ?? 0,
                        launchSpeedSeconds: item.timeToPoolCreationSeconds ?? 0,
                    };

                    console.log("🟢 Detected new pump.fun token:", token.mint);
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
