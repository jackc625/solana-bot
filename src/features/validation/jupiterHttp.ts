// src/features/validation/jupiterHttp.ts
// HTTP-based Jupiter API client to replace problematic SDK

import { PublicKey } from "@solana/web3.js";
import { loadBotConfig } from "../../config/index.js";
import logger from "../../utils/logger.js";

const config = loadBotConfig();
const JUPITER_API_BASE = "https://quote-api.jup.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Rate limiting implementation
class JupiterRateLimiter {
    private lastRequestTime = 0;
    private readonly minInterval = 200; // Minimum 200ms between requests
    private requestQueue: Array<() => Promise<any>> = [];
    private processing = false;

    async throttle<T>(fn: () => Promise<T>): Promise<T> {
        return new Promise((resolve, reject) => {
            this.requestQueue.push(async () => {
                try {
                    const result = await fn();
                    resolve(result);
                } catch (error) {
                    reject(error);
                }
            });
            
            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    private async processQueue() {
        if (this.processing || this.requestQueue.length === 0) return;
        
        this.processing = true;
        
        while (this.requestQueue.length > 0) {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            
            if (timeSinceLastRequest < this.minInterval) {
                const delay = this.minInterval - timeSinceLastRequest;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
            const request = this.requestQueue.shift();
            if (request) {
                this.lastRequestTime = Date.now();
                await request();
            }
        }
        
        this.processing = false;
    }
}

const rateLimiter = new JupiterRateLimiter();

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
    slippageBps?: number,
    retryCount: number = 0
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

    return rateLimiter.throttle(async () => {
        try {
            const response = await fetch(`${JUPITER_API_BASE}/v6/quote?${params}`, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                }
            });

            if (response.status === 429) {
                // Rate limited - implement exponential backoff
                if (retryCount < 3) {
                    const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
                    logger.warn("JUPITER_HTTP", `Rate limited, retrying in ${delay}ms (attempt ${retryCount + 1}/3)`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    return getJupiterQuote(inputMint, outputMint, amount, slippageBps, retryCount + 1);
                } else {
                    logger.warn("JUPITER_HTTP", "Max retries reached for rate limiting");
                    return null;
                }
            }

            if (!response.ok) {
                const url = `${JUPITER_API_BASE}/v6/quote?${params}`;
                logger.warn("JUPITER_HTTP", `Quote request failed: ${response.status} ${response.statusText}`, {
                    url,
                    inputMint,
                    outputMint,
                    amount: amountLamports
                });
                return null;
            }

            const data = await response.json();
            return data;
        } catch (error) {
            logger.error("JUPITER_HTTP", "Failed to get quote", {}, error);
            return null;
        }
    });
}

export async function getJupiterSwap(
    quoteResponse: JupiterQuoteResponse,
    userPublicKey: string
): Promise<JupiterSwapResponse | null> {
    return rateLimiter.throttle(async () => {
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

            if (response.status === 429) {
                logger.warn("JUPITER_HTTP", "Swap request rate limited");
                return null;
            }

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
    });
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