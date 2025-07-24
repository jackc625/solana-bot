// src/monitor/livePump.ts

import fetch from "node-fetch";
import { PublicKey } from "@solana/web3.js";
import { PumpToken } from "./pumpFun.js";
import { Jupiter } from "@jup-ag/core";
import { connection } from "../utils/solana.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";
import { getLpLiquidity } from "../utils/jupiter.js";
import { getJupiter } from "../utils/jupiterInstance.js";
import { getLpTokenAddress } from "../utils/getLpTokenAddress.js";

const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const seenMints: Record<string, number> = {};
const solMint = new PublicKey("So11111111111111111111111111111111111111112");

interface PumpApiResponse {
    tokenId: string;
    creator: string;
    timestamp: number;
    name: string;
    symbol: string;
}

export const monitorLivePumpFun = async (onNewToken: (token: PumpToken) => void) => {
    const jupiter = await getJupiter();

    const poll = async () => {
        try {
            const res = await fetch("https://pump.fun/api/launchpad/launches?limit=50");
            const data: PumpApiResponse[] = await res.json();

            const now = Date.now();
            for (const item of data) {
                const mint = item.tokenId;
                if (!mint) continue;

                if (!seenMints[mint] || now - seenMints[mint] > SEEN_TTL_MS) {
                    seenMints[mint] = now;

                    const tokenMint = new PublicKey(mint);
                    const hasJupiterRoute = await hasDirectJupiterRoute(jupiter, solMint, tokenMint);
                    const lpTokenAddress = await getLpTokenAddress(jupiter, solMint, tokenMint);
                    const simulatedLp = await getLpLiquidity(jupiter, solMint.toBase58(), mint) ?? 0;

                    // Fetch extra metadata including earlyBuyerCount
                    let earlyHolders = 0;
                    try {
                        const detailsRes = await fetch(`https://pump.fun/coin/${mint}`);
                        const details = await detailsRes.json();
                        earlyHolders = details.earlyBuyerCount ?? 0;
                    } catch (e) {
                        console.warn(`⚠️ Failed to fetch /coin/${mint}:`, e);
                    }

                    const token: PumpToken = {
                        mint,
                        creator: item.creator,
                        launchedAt: item.timestamp * 1000,
                        simulatedLp,
                        hasJupiterRoute,
                        lpTokenAddress,
                        metadata: {
                            name: item.name,
                            symbol: item.symbol,
                            decimals: 9,
                        },
                        earlyHolders,
                        launchSpeedSeconds: 0,
                    };

                    console.log("🟢 LIVE token detected:", token.mint);
                    onNewToken(token);
                }
            }
        } catch (err) {
            console.error("❌ Error polling pump.fun:", err);
        }

        setTimeout(poll, 5000);
    };

    setInterval(() => {
        const now = Date.now();
        for (const mint in seenMints) {
            if (now - seenMints[mint] > SEEN_TTL_MS) {
                delete seenMints[mint];
            }
        }
    }, 60_000); // cleanup every 1 minute

    poll();
};