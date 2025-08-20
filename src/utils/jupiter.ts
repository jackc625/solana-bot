// src/utils/jupiter.ts

import { Jupiter, RouteInfo } from "@jup-ag/core";
import { PublicKey, VersionedTransaction, Transaction } from "@solana/web3.js";
import JSBIImport from "jsbi";
import { connection } from "./solana.js";
import { loadBotConfig } from "../config/index.js";
import PQueueModule from "p-queue";
import { shouldCooldown, triggerCooldown } from "./globalCooldown.js";
import logger from "./logger.js";
import { computeSwapHttp, simulateSellHttp, getLpLiquidityHttp } from "./jupiterHttp.js";

const PQueue = (PQueueModule as any).default ?? PQueueModule;
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const config = loadBotConfig();

const JSBI: any = JSBIImport;

const jupiterCache = new Map<string, Jupiter>();

async function getSharedJupiter(user: PublicKey): Promise<Jupiter> {
    const key = user.toBase58();

    if (jupiterCache.has(key)) return jupiterCache.get(key)!;

    try {
        const instance = await Jupiter.load({
            connection,
            cluster: "mainnet-beta",
            user,
        });

        jupiterCache.set(key, instance);
        return instance;
    } catch (err: any) {
        logger.error(
            "JUPITER_INIT",
            "Failed to initialize Jupiter instance",
            {
                user: user.toBase58().substring(0, 8) + "...",
            },
            err
        );

        // If this is an assertion error from the SDK, clear cache and retry once
        if (err?.message?.includes("Assertion failed")) {
            logger.warn("JUPITER_INIT", "Clearing Jupiter cache due to assertion failure");
            jupiterCache.clear();

            // Wait a bit before retry
            await new Promise((resolve) => setTimeout(resolve, 2000));

            try {
                const instance = await Jupiter.load({
                    connection,
                    cluster: "mainnet-beta",
                    user,
                });
                jupiterCache.set(key, instance);
                return instance;
            } catch (retryErr: any) {
                logger.error("JUPITER_INIT", "Retry also failed - Jupiter unavailable", {}, retryErr);
                throw retryErr;
            }
        }
        throw err;
    }
}

// ---- CLMM tick-array crash detector ----
function isClmmTickArrayCrash(err: unknown): boolean {
    const s = String((err as any)?.stack || (err as any)?.message || err);
    return (
        s.includes("@jup-ag/raydium-clmm-sdk") ||
        s.includes("TickUtils") ||
        s.includes("getInitializedTickArrayInRange") ||
        (s.includes("bn.js") && s.includes("iushrn"))
    );
}

// ---- Normalize any swapTransaction → base64 string ----
function txToBase64(
    tx: string | Transaction | VersionedTransaction | undefined | null
): string | undefined {
    if (!tx) return undefined;
    if (typeof tx === "string") return tx; // already base64 (older @jup-ag/core)
    try {
        const buf = tx.serialize(); // both Transaction & VersionedTransaction have serialize()
        return Buffer.from(buf).toString("base64");
    } catch {
        // fall through
    }
    // Some versions might nest; try common shapes defensively
    const anyTx = tx as any;
    if (anyTx?.transaction && typeof anyTx.transaction.serialize === "function") {
        const buf = anyTx.transaction.serialize();
        return Buffer.from(buf).toString("base64");
    }
    throw new Error("Unsupported swapTransaction type (expected string or *Transaction)");
}

// TTL cache to avoid duplicate swap requests
const recentQuotes = new Map<string, number>();
const TTL_MS = 10_000; // 10 seconds

setInterval(() => {
    const now = Date.now();
    for (const [key, timestamp] of recentQuotes.entries()) {
        if (now - timestamp > TTL_MS) {
            recentQuotes.delete(key);
        }
    }
}, 60_000); // Run every 60 seconds

const jupiterQueue = new PQueue({
    concurrency: 1,
    interval: 1000,
    intervalCap: 5,
    carryoverConcurrencyCount: true,
});

let consecutive429s = 0;
let consecutiveFails = 0;
let lastCooldown = 0;

export async function computeSwap(
    outputMint: string,
    amount: number,
    userPublicKey: PublicKey
): Promise<(RouteInfo & { swapTransaction?: string }) | null> {
    if (shouldCooldown()) {
        console.warn("🛑 Skipping Jupiter call — global cooldown active.");
        return null;
    }

    const dedupKey = `${outputMint}:${amount.toFixed(4)}`;
    const now = Date.now();
    if (recentQuotes.has(dedupKey) && now - recentQuotes.get(dedupKey)! < TTL_MS) {
        console.warn(`🧠 Skipping duplicate Jupiter computeSwap for ${dedupKey}`);
        return null;
    }
    recentQuotes.set(dedupKey, now);

    try {
        if (now - lastCooldown < 10_000) {
            console.warn("⏳ Global cooldown active... waiting");
            await new Promise((r) => setTimeout(r, 2000));
        }

        console.log(`📡 Jupiter HTTP API hit at ${new Date().toISOString()}`);

        // Use HTTP API instead of problematic SDK
        const result = await computeSwapHttp(outputMint, amount, userPublicKey);
        if (!result || !result.swapTransaction) {
            return null;
        }

        consecutive429s = 0;
        consecutiveFails = 0;
        logger.recordSuccess("JUPITER");

        // Convert to expected format for backward compatibility
        return {
            inputMint: SOL_MINT,
            outputMint: new PublicKey(outputMint),
            inAmount: JSBI.BigInt(Math.floor(amount * 1e9)),
            outAmount: JSBI.BigInt(result.outAmount || "0"),
            otherAmountThreshold: JSBI.BigInt(result.outAmount || "0"),
            swapMode: "ExactIn" as any,
            slippageBps: config.slippage * 100,
            priceImpactPct: parseFloat(result.priceImpactPct || "0"),
            swapTransaction: result.swapTransaction,
        } as any;
    } catch (err: any) {
        logger.recordFailure("JUPITER");
        const msg = err?.message || err?.toString() || "";

        if (msg.includes("429") || msg.includes("Too Many Requests")) {
            consecutive429s += 1;
            logger.warn("JUPITER", `Rate limited (${consecutive429s} consecutive)`, {
                outputMint,
                amount,
                consecutiveCount: consecutive429s,
            });
            triggerCooldown(15_000);
        } else {
            logger.error(
                "JUPITER",
                "Route computation failed",
                {
                    outputMint,
                    amount,
                },
                err
            );
        }

        return null;
    }
}

export async function getLpLiquidity(
    jupiter: Jupiter,
    inputMint: string,
    outputMint: string,
    amountInSol = 0.1
): Promise<number | null> {
    try {
        console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

        const result = await jupiterQueue.add(async () => {
            console.log(`[QUEUE] Queue size: ${jupiterQueue.size} | Pending: ${jupiterQueue.pending}`);

            console.log(`🔁 [getLpLiquidity] Simulating LP for ${inputMint} → ${outputMint}`);

            const baseParams: any = {
                inputMint: new PublicKey(inputMint),
                outputMint: new PublicKey(outputMint),
                amount: JSBI.BigInt(Math.floor(amountInSol * 1e9)),
                slippageBps: 50,
            };

            let routes: any;
            try {
                routes = await jupiter.computeRoutes(baseParams);
            } catch (e) {
                if (isClmmTickArrayCrash(e)) {
                    logger.warn("JUPITER", "CLMM tick-array crash in getLpLiquidity — retrying without CLMM/Whirlpool", {
                        inputMint,
                        outputMint,
                    });
                    const retryParams = {
                        ...baseParams,
                        excludeDexes: ["Raydium CLMM", "Whirlpool", "Orca Whirlpool"],
                    } as any;
                    routes = await jupiter.computeRoutes(retryParams);
                } else {
                    throw e;
                }
            }

            const best = routes?.routesInfos?.[0];
            if (!best || !best.outAmount) return null;

            // Return outAmount normalized to SOL (1e9)
            return Number(best.outAmount.toString()) / 1e9;
        });

        return result;
    } catch (e) {
        console.error(`❌ getLpLiquidity failed for ${outputMint}:`, e);
        return null;
    }
}

export async function simulateSell({
                                       tokenMint,
                                       tokenAmount,
                                       userPubkey,
                                   }: {
    tokenMint: string;
    tokenAmount: number;
    userPubkey: PublicKey;
}): Promise<{ expectedOut: number; success: boolean }> {
    if (shouldCooldown()) {
        console.warn("🛑 Skipping sell simulation — cooldown active.");
        return { expectedOut: 0, success: false };
    }

    const key = `${tokenMint}:${tokenAmount}`;
    const now = Date.now();
    if (recentQuotes.has(key) && now - recentQuotes.get(key)! < TTL_MS) {
        console.warn(`🌀 Skipping duplicate simulation for ${key}`);
        return { expectedOut: 0, success: false };
    }
    recentQuotes.set(key, now);

    try {
        console.log(`📡 Jupiter HTTP API simulation at ${new Date().toISOString()}`);
        
        // Use HTTP API for sell simulation
        const result = await simulateSellHttp({
            tokenMint,
            tokenAmount,
            userPubkey,
        });

        return result;
    } catch (err) {
        console.warn(`❌ Sell simulation failed for ${tokenMint}:`, (err as Error)?.message || err);
        return { expectedOut: 0, success: false };
    }
}

// Enhanced honeypot detection with multiple test amounts and tax analysis
export interface HoneypotTestResult {
    passed: boolean;
    buyPass: boolean;
    sellPass: boolean;
    taxAnalysis?: {
        buyTaxPercent: number;
        sellTaxPercent: number;
        exceedsThreshold: boolean;
    };
    multiAmountResults?: {
        amount: number;
        sellPass: boolean;
        expectedSol: number;
        actualSol: number;
        valueRetained: number; // percentage of value retained
    }[];
    reason?: string;
}

export async function enhancedHoneypotDetection(
    mintAddress: PublicKey,
    userPubkey: PublicKey,
    testAmounts: number[] = [0.001, 0.01, 0.1],
    maxSellTaxPercent: number = 95
): Promise<HoneypotTestResult> {
    try {
        const jup = await getSharedJupiter(userPubkey);
        if (!jup) {
            return {
                passed: false,
                buyPass: false,
                sellPass: false,
                reason: "Jupiter instance unavailable"
            };
        }

        const results: HoneypotTestResult = {
            passed: false,
            buyPass: false,
            sellPass: false,
            multiAmountResults: []
        };

        // Test each amount progressively
        for (const testAmount of testAmounts) {
            logger.info("HONEYPOT", `Testing amount: ${testAmount} SOL`, { mint: mintAddress.toBase58(), testAmount });

            // 1. Simulate BUY (SOL → Token)
            const buyRoute = await computeSwap(mintAddress.toBase58(), testAmount, userPubkey);
            if (!buyRoute || !buyRoute.swapTransaction) {
                logger.warn("HONEYPOT", `Buy route failed for ${testAmount} SOL`, { mint: mintAddress.toBase58() });
                results.multiAmountResults!.push({
                    amount: testAmount,
                    sellPass: false,
                    expectedSol: 0,
                    actualSol: 0,
                    valueRetained: 0
                });
                continue;
            }

            // Simulate the buy transaction
            let buySimResult;
            try {
                buySimResult = await connection.simulateTransaction(
                    VersionedTransaction.deserialize(Buffer.from(buyRoute.swapTransaction, "base64"))
                );
                results.buyPass = buySimResult.value.err === null;
            } catch (err) {
                logger.warn("HONEYPOT", `Buy simulation failed for ${testAmount} SOL`, { 
                    mint: mintAddress.toBase58(), 
                    error: (err as Error)?.message || err 
                });
                continue;
            }

            if (!results.buyPass) {
                logger.warn("HONEYPOT", `Buy transaction would fail for ${testAmount} SOL`, { mint: mintAddress.toBase58() });
                continue;
            }

            // Calculate expected tokens from buy
            const expectedTokens = Number(buyRoute.outAmount.toString()) / Math.pow(10, 9); // Assuming 9 decimals

            // 2. Simulate SELL (Token → SOL) with the tokens we would get
            const sellParams: any = {
                inputMint: mintAddress,
                outputMint: SOL_MINT,
                amount: buyRoute.outAmount,
                slippageBps: config.slippage * 100,
            };

            let sellRoute: any;
            try {
                sellRoute = await jup.computeRoutes(sellParams);
            } catch (e) {
                if (isClmmTickArrayCrash(e)) {
                    logger.warn("HONEYPOT", "CLMM tick-array crash in sell route — retrying without CLMM/Whirlpool", {
                        mint: mintAddress.toBase58(),
                    });
                    const retryParams = {
                        ...sellParams,
                        excludeDexes: ["Raydium CLMM", "Whirlpool", "Orca Whirlpool"],
                    } as any;
                    sellRoute = await jup.computeRoutes(retryParams);
                } else {
                    throw e;
                }
            }

            const sellInfo = sellRoute?.routesInfos?.[0];
            let sellPass = false;
            let actualSolOut = 0;

            if (sellInfo) {
                try {
                    const { swapTransaction } = await jup.exchange({
                        routeInfo: sellInfo,
                        userPublicKey: userPubkey,
                    });
                    const sellTxBase64 = txToBase64(swapTransaction);
                    
                    if (sellTxBase64) {
                        const simSell = await connection.simulateTransaction(
                            VersionedTransaction.deserialize(Buffer.from(sellTxBase64, "base64"))
                        );
                        sellPass = simSell.value.err === null;
                        
                        if (sellPass) {
                            actualSolOut = Number(sellInfo.outAmount.toString()) / 1e9;
                        }
                    }
                } catch (e) {
                    if (isClmmTickArrayCrash(e)) {
                        logger.warn("HONEYPOT", "CLMM tick-array crash in sell exchange — retrying without CLMM/Whirlpool");
                        const retryParams = {
                            ...sellParams,
                            excludeDexes: ["Raydium CLMM", "Whirlpool", "Orca Whirlpool"],
                        } as any;
                        const retroute = await jup.computeRoutes(retryParams);
                        const retryInfo = retroute?.routesInfos?.[0];
                        if (retryInfo) {
                            const { swapTransaction } = await jup.exchange({
                                routeInfo: retryInfo,
                                userPublicKey: userPubkey,
                            });
                            const sellTxBase64 = txToBase64(swapTransaction);
                            if (sellTxBase64) {
                                const simSell = await connection.simulateTransaction(
                                    VersionedTransaction.deserialize(Buffer.from(sellTxBase64, "base64"))
                                );
                                sellPass = simSell.value.err === null;
                                if (sellPass) {
                                    actualSolOut = Number(retryInfo.outAmount.toString()) / 1e9;
                                }
                            }
                        }
                    } else {
                        throw e;
                    }
                }
            }

            // Calculate value retention percentage
            const valueRetained = testAmount > 0 ? (actualSolOut / testAmount) * 100 : 0;
            
            // Calculate implicit sell tax
            const implicitSellTax = testAmount > 0 ? Math.max(0, (1 - actualSolOut / testAmount) * 100) : 100;

            results.multiAmountResults!.push({
                amount: testAmount,
                sellPass,
                expectedSol: testAmount, // What we put in
                actualSol: actualSolOut, // What we get back
                valueRetained
            });

            logger.info("HONEYPOT", `Test result for ${testAmount} SOL`, {
                mint: mintAddress.toBase58(),
                sellPass,
                valueRetained: valueRetained.toFixed(2),
                implicitSellTax: implicitSellTax.toFixed(2),
                actualSolOut: actualSolOut.toFixed(6)
            });

            // If sell fails completely, this is likely a honeypot
            if (!sellPass) {
                results.sellPass = false;
                results.reason = `Sell simulation failed for ${testAmount} SOL`;
                logger.warn("HONEYPOT", `HONEYPOT DETECTED: Sell failed for ${testAmount} SOL`, {
                    mint: mintAddress.toBase58()
                });
                return results;
            }

            // If value retention is extremely low, likely honeypot
            if (valueRetained < (100 - maxSellTaxPercent)) {
                results.sellPass = false;
                results.reason = `Excessive sell tax: ${implicitSellTax.toFixed(1)}% (retained only ${valueRetained.toFixed(1)}%)`;
                logger.warn("HONEYPOT", `HONEYPOT DETECTED: Excessive sell tax`, {
                    mint: mintAddress.toBase58(),
                    sellTax: implicitSellTax.toFixed(1),
                    valueRetained: valueRetained.toFixed(1),
                    threshold: maxSellTaxPercent
                });
                return results;
            }

            // Calculate tax analysis for this test
            if (!results.taxAnalysis) {
                const buyTax = 0; // Difficult to calculate buy tax without executing
                const sellTax = implicitSellTax;
                
                results.taxAnalysis = {
                    buyTaxPercent: buyTax,
                    sellTaxPercent: sellTax,
                    exceedsThreshold: sellTax > maxSellTaxPercent
                };
            }
        }

        // If we made it through all tests, mark as passed
        const allSellsPassed = results.multiAmountResults!.every(r => r.sellPass);
        const reasonableValueRetention = results.multiAmountResults!.every(r => r.valueRetained > (100 - maxSellTaxPercent));

        results.sellPass = allSellsPassed && reasonableValueRetention;
        results.passed = results.buyPass && results.sellPass;

        if (results.passed) {
            logger.info("HONEYPOT", "Token passed enhanced honeypot detection", {
                mint: mintAddress.toBase58(),
                testAmounts: testAmounts.length,
                averageValueRetention: (results.multiAmountResults!.reduce((sum, r) => sum + r.valueRetained, 0) / results.multiAmountResults!.length).toFixed(2)
            });
        }

        return results;

    } catch (err) {
        logger.error("HONEYPOT", "Enhanced honeypot detection failed", { 
            mint: mintAddress.toBase58(), 
            error: (err as Error)?.message || err 
        });
        return {
            passed: false,
            buyPass: false,
            sellPass: false,
            reason: `Detection error: ${(err as Error)?.message || err}`
        };
    }
}

// Legacy function for backward compatibility
export async function simulateBuySell(
    mintPk: PublicKey,
    rpcEndpoint: string,
    userPubkeyBase58: string,
    amountSOL: number
): Promise<{ passed: boolean; buyPass: boolean; sellPass: boolean }> {
    try {
        const userPubkey = new PublicKey(userPubkeyBase58);
        const result = await enhancedHoneypotDetection(mintPk, userPubkey, [amountSOL]);
        
        return {
            passed: result.passed,
            buyPass: result.buyPass,
            sellPass: result.sellPass
        };
    } catch (err) {
        logger.warn("HONEYPOT", "Legacy simulateBuySell error", { 
            mint: mintPk.toBase58(), 
            error: (err as Error)?.message || err 
        });
        return { passed: false, buyPass: false, sellPass: false };
    }
}

export { jupiterQueue };
export { getSharedJupiter };
