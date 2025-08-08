// src/utils/getLpTokenAddress.ts

import { PublicKey } from "@solana/web3.js";
import { Jupiter } from "@jup-ag/core";
import JSBIImport from "jsbi";
import { jupiterQueue } from "./jupiter.js";

const JSBI: any = JSBIImport;

export const getLpTokenAddress = async (
    jupiter: Jupiter,
    inputMint: PublicKey,
    outputMint: PublicKey
): Promise<string> => {
    return jupiterQueue.add(async () => {
        try {
            const routes = await jupiter.computeRoutes({
                inputMint,
                outputMint,
                amount: JSBI.BigInt(1_000_000), // 0.001 SOL
                slippageBps: 100,
                forceFetch: true,
            });

            const bestRoute = routes?.routesInfos?.[0];
            const market = bestRoute?.marketInfos?.[0];

            if (market) {
                const marketLabel = market?.amm.label ?? "unknown";
                const pair = `${inputMint.toBase58().slice(0, 4)}-${outputMint.toBase58().slice(0, 4)}`;
                return `LP_${marketLabel}_${pair}`;
            }

            return "LP_unknown";
        } catch (err) {
            console.warn("⚠️ Failed to compute LP token address:", (err as Error).message);
            return "LP_unknown";
        }
    });
};
