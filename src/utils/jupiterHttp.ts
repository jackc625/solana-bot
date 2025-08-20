// src/utils/jupiterHttp.ts
// HTTP-based Jupiter API client to replace problematic SDK

import { PublicKey } from "@solana/web3.js";
import { loadBotConfig } from "../config/index.js";
import logger from "./logger.js";

const config = loadBotConfig();
const JUPITER_API_BASE = "https://lite-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";

interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    platformFee?: any;
    priceImpactPct: string;
    routePlan: Array<{
        swapInfo: {
            ammKey: string;
            label: string;
            inputMint: string;
            outputMint: string;
            inAmount: string;
            outAmount: string;
            feeAmount: string;
            feeMint: string;
        };
        percent: number;
    }>;
    contextSlot?: number;
    timeTaken?: number;
}

interface JupiterSwapResponse {
    swapTransaction: string;
    lastValidBlockHeight?: number;
    prioritizationFeeLamports?: number;
}

export async function getJupiterQuote(
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps?: number
): Promise<JupiterQuoteResponse | null> {
    const slippage = slippageBps ?? (config.slippage * 100);
    const amountLamports = Math.floor(amount * 1e9);
    
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amountLamports.toString(),
        slippageBps: slippage.toString(),
        onlyDirectRoutes: "false",
        asLegacyTransaction: "false"
    });

    try {
        const response = await fetch(`${JUPITER_API_BASE}/v6/quote?${params}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            }
        });

        if (!response.ok) {
            logger.warn("JUPITER_HTTP", `Quote request failed: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        return data;
    } catch (error) {
        logger.error("JUPITER_HTTP", "Failed to get quote", {}, error);
        return null;
    }
}

export async function getJupiterSwap(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string
): Promise<JupiterSwapResponse | null> {
    try {
        const response = await fetch(`${JUPITER_API_BASE}/v6/swap`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey,
                wrapAndUnwrapSol: true,
                computeUnitPriceMicroLamports: "auto"
            })
        });

        if (!response.ok) {
            logger.warn("JUPITER_HTTP", `Swap request failed: ${response.status} ${response.statusText}`);
            return null;
        }

        const data = await response.json();
        return data;
    } catch (error) {
        logger.error("JUPITER_HTTP", "Failed to get swap transaction", {}, error);
        return null;
    }
}

export async function computeSwapHttp(
    outputMint: string,
    amount: number,
    userPublicKey: PublicKey
): Promise<{ swapTransaction?: string; outAmount?: string; priceImpactPct?: string } | null> {
    try {
        // Get quote
        const quote = await getJupiterQuote(SOL_MINT, outputMint, amount);
        if (!quote) {
            return null;
        }

        // Get swap transaction
        const swap = await getJupiterSwap(quote, userPublicKey.toBase58());
        if (!swap) {
            return null;
        }

        return {
            swapTransaction: swap.swapTransaction,
            outAmount: quote.outAmount,
            priceImpactPct: quote.priceImpactPct
        };
    } catch (error) {
        logger.error("JUPITER_HTTP", "computeSwapHttp failed", { outputMint, amount }, error);
        return null;
    }
}

export async function simulateSellHttp({
    tokenMint,
    tokenAmount,
    userPubkey,
}: {
    tokenMint: string;
    tokenAmount: number;
    userPubkey: PublicKey;
}): Promise<{ expectedOut: number; success: boolean }> {
    try {
        const quote = await getJupiterQuote(tokenMint, SOL_MINT, tokenAmount);
        if (!quote) {
            return { expectedOut: 0, success: false };
        }

        const expectedOut = Number(quote.outAmount) / 1e9; // Convert lamports to SOL
        return {
            expectedOut,
            success: expectedOut > 0,
        };
    } catch (error) {
        logger.warn("JUPITER_HTTP", `Sell simulation failed for ${tokenMint}`, { error });
        return { expectedOut: 0, success: false };
    }
}

export async function hasDirectJupiterRouteHttp(
    inputMint: string,
    outputMint: string
): Promise<boolean> {
    try {
        const quote = await getJupiterQuote(inputMint, outputMint, 0.001); // Small test amount
        return quote !== null && quote.routePlan.length > 0;
    } catch (error) {
        logger.warn("JUPITER_HTTP", "Route check failed", { inputMint, outputMint, error });
        return false;
    }
}

export async function getLpLiquidityHttp(
    inputMint: string,
    outputMint: string,
    amountInSol = 0.1
): Promise<number | null> {
    try {
        const quote = await getJupiterQuote(inputMint, outputMint, amountInSol);
        if (!quote) {
            return null;
        }

        // Return output amount normalized to SOL (1e9)
        return Number(quote.outAmount) / 1e9;
    } catch (error) {
        logger.error("JUPITER_HTTP", `getLpLiquidityHttp failed for ${outputMint}`, {}, error);
        return null;
    }
}