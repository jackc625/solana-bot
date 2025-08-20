// src/utils/hasDirectJupiterRoute.ts

import { PublicKey } from "@solana/web3.js";
import { Jupiter } from "@jup-ag/core";
import JSBIImport from "jsbi";
import { jupiterQueue } from "./jupiter.js";
import { hasDirectJupiterRouteHttp } from "./jupiterHttp.js";

const JSBI: any = JSBIImport;

export const hasDirectJupiterRoute = async (
    jupiter: Jupiter | null,
    inputMint: PublicKey,
    outputMint: PublicKey
): Promise<boolean> => {
    try {
        // Use HTTP API instead of problematic SDK
        const result = await hasDirectJupiterRouteHttp(
            inputMint.toBase58(),
            outputMint.toBase58()
        );
        return result;
    } catch (e: any) {
        console.warn(
            `⚠️ Failed to check Jupiter route for ${inputMint.toBase58()} ↔ ${outputMint.toBase58()}:`,
            e?.message || e
        );
        return false;
    }
};
