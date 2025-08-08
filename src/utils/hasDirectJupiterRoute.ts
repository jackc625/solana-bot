// src/utils/hasDirectJupiterRoute.ts

import { PublicKey } from "@solana/web3.js";
import { Jupiter } from "@jup-ag/core";
import JSBIImport from "jsbi";
import { jupiterQueue } from "./jupiter.js";

const JSBI: any = JSBIImport;

export const hasDirectJupiterRoute = async (
    jupiter: Jupiter,
    inputMint: PublicKey,
    outputMint: PublicKey
): Promise<boolean> => {
    console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

    return jupiterQueue.add(async () => {
        try {
            const routes = await jupiter.computeRoutes({
                inputMint,
                outputMint,
                amount: JSBI.BigInt(1_000_000), // 0.001 SOL
                slippageBps: 100,
                forceFetch: true,
                onlyDirectRoutes: true,
            });

            return (routes?.routesInfos?.length ?? 0) > 0;
        } catch (e: any) {
            console.warn(
                `⚠️ Failed to check Jupiter route for ${inputMint.toBase58()} ↔ ${outputMint.toBase58()}:`,
                e?.message || e
            );
            return false;
        }
    });
};
