// src/utils/getLpTokenAddress.ts
// Deprecated: LP token address inference via Jupiter route is unreliable for most AMMs.
// Retained only for compatibility. Always returns "LP_unknown".

import { PublicKey } from "@solana/web3.js";

export const getLpTokenAddress = async (
    _jupiter: any,
    _inputMint: PublicKey,
    _outputMint: PublicKey
): Promise<string> => {
    console.warn("ℹ️ getLpTokenAddress is deprecated and returns 'LP_unknown'. Use AMM-specific vault decoding if needed.");
    return "LP_unknown";
};
