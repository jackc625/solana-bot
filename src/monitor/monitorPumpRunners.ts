// src/monitor/monitorPumpRunners.ts

import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import { PumpToken } from "./pumpFun.js";
import { getSharedJupiter } from "../utils/jupiter.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";

const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const seenMints: Record<string, number> = {};
const solMint = new PublicKey("So11111111111111111111111111111111111111112");

export const monitorPumpRunners = async (
    onNewToken: (token: Omit<PumpToken, "lpTokenAddress">) => void
) => {
    const jupiter = await getSharedJupiter(solMint);

    const poll = async () => {
        try {
            const res = await fetch("https://pump.fun/api/runners");
            const data = await res.json();
            const now = Date.now();

            for (const entry of data) {
                const coin = entry.coin;
                if (!coin || !coin.mint) continue;

                if (!seenMints[coin.mint] || now - seenMints[coin.mint] > SEEN_TTL_MS) {
                    seenMints[coin.mint] = now;

                    const tokenMint = new PublicKey(coin.mint);
                    const hasJupiterRoute = await hasDirectJupiterRoute(jupiter, solMint, tokenMint);

                    const token = {
                        mint: coin.mint,
                        creator: coin.creator,
                        launchedAt: coin.created_timestamp,
                        simulatedLp: coin.virtual_sol_reserves / 1e9,
                        hasJupiterRoute,
                        metadata: {
                            name: coin.name,
                            symbol: coin.symbol,
                            decimals: 9,
                        },
                        earlyHolders: Math.floor(Math.random() * 200),
                        launchSpeedSeconds: 0,
                    };

                    onNewToken(token);
                }
            }
        } catch (err) {
            console.error("❌ Error polling pump.fun runners:", err);
        }

        setTimeout(poll, 6000);
    };

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
