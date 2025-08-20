// src/utils/pumpTrade.ts
import { VersionedTransaction, Connection, Keypair } from "@solana/web3.js";
import { calcPriorityFeeSOL } from "./priorityFee.js";
import { fetchWithTimeout } from "./withTimeout.js";

const TRADE_URL = "https://pumpportal.fun/api/trade-local";

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function sendPumpTrade({
                                        connection,
                                        wallet,
                                        mint,
                                        amount,
                                        action = "buy",
                                        slippage = 10,
                                        priorityFee,
                                        pool = "auto",
                                        denominatedInSol = true,
                                    }: {
    connection: Connection;
    wallet: Keypair;
    mint: string;
    amount: number;
    action?: "buy" | "sell";
    slippage?: number;
    priorityFee?: number;
    pool?: string;
    denominatedInSol?: boolean;
}): Promise<string | null> {
    try {
        // Compute a network-adaptive priority fee unless caller passed one
        const dynamicPriorityFee = await calcPriorityFeeSOL(connection, 1_200_000, 0.90);
        const priorityFeeToUse =
            typeof priorityFee === "number" && priorityFee > 0 ? priorityFee : dynamicPriorityFee;

        // Prepare payload once (shared by retry)
        const payload = {
            publicKey: wallet.publicKey.toBase58(),
            action,
            mint,
            amount,
            denominatedInSol: denominatedInSol ? "true" : "false",
            slippage,
            priorityFee: priorityFeeToUse,
            pool,
        };

        // One timed attempt helper
        const attempt = async () =>
            fetchWithTimeout(TRADE_URL, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                timeoutMs: 1800, // fail fast; we’ll retry once on server trouble
            });

        // First try
        let res = await attempt();

        // Quick jittered backoff + one retry on 429/5xx
        if (res.status === 429 || res.status >= 500) {
            await sleep(300 + Math.floor(Math.random() * 400));
            res = await attempt();
        }

        if (!res.ok) {
            const text = await res.text().catch(() => "");
            console.warn(`❌ PumpPortal API returned ${res.status}: ${res.statusText} ${text ? `- ${text}` : ""}`);
            return null;
        }

        const buffer = await res.arrayBuffer();
        const tx = VersionedTransaction.deserialize(new Uint8Array(buffer));
        tx.sign([wallet]);

        const sig = await connection.sendTransaction(tx);
        
        // SAFETY-005: Transaction confirmation validation
        if (!sig || typeof sig !== 'string' || sig.length < 32) {
            console.error("❌ Invalid transaction signature returned:", sig);
            return null;
        }
        
        // Basic transaction confirmation check
        try {
            const confirmation = await connection.confirmTransaction(sig, 'confirmed');
            if (confirmation.value.err) {
                console.error("❌ Transaction failed with error:", confirmation.value.err);
                return null;
            }
        } catch (confirmError) {
            console.warn("⚠️ Transaction confirmation check failed (transaction may still succeed):", confirmError);
            // Don't fail here as the transaction might still be valid
        }
        
        console.log("✅ Sent PumpPortal transaction:", sig);
        return sig;
    } catch (err) {
        console.error("💥 Error sending PumpPortal transaction:", err);
        return null;
    }
}
