// src/utils/getLpTokenAddress.ts

import { PublicKey } from "@solana/web3.js";
import { Jupiter, RouteInfo } from "@jup-ag/core";
import JSBI from "jsbi";
import { jupiterQueue } from "./jupiter.js";

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
                amount: (JSBI as any).BigInt(1_000_000), // 0.001 SOL
                slippageBps: 100,
                forceFetch: true,
            });

            const bestRoute: RouteInfo | undefined = routes?.routesInfos?.[0];

            // Jupiter no longer exposes lpAddress directly, so this is just a fallback
            const firstMarket = bestRoute?.marketInfos?.[0];

            const fallback = inputMint.toBase58().slice(0, 4) + outputMint.toBase58().slice(-4);
            const simulated = `SimulatedLP_${fallback}`;

            if (!firstMarket) {
                console.warn("⚠️ No marketInfos found in best route.");
                return simulated;
            }

            // Custom fallback format if lpAddress is not present
            return simulated;
        } catch (err) {
            console.warn("⚠️ Failed to compute LP token address:", (err as Error).message);
            return "SimulatedLP_unknown";
        }
    });
};
