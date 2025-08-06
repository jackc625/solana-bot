// src/utils/pumpTrade.ts
import { VersionedTransaction, Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const TRADE_URL = "https://pumpportal.fun/api/trade-local";

export async function sendPumpTrade({
                                        connection,
                                        wallet,
                                        mint,
                                        amount,
                                        action = "buy",
                                        slippage = 10,
                                        priorityFee = 0.00001,
                                        pool = "auto",
                                        denominatedInSol = true
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
        const res = await fetch(TRADE_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                publicKey: wallet.publicKey.toBase58(),
                action,
                mint,
                amount,
                denominatedInSol: denominatedInSol ? "true" : "false",
                slippage,
                priorityFee,
                pool
            })
        });

        if (res.status !== 200) {
            console.warn(`❌ PumpPortal API returned ${res.status}: ${res.statusText}`);
            return null;
        }

        const buffer = await res.arrayBuffer();
        const tx = VersionedTransaction.deserialize(new Uint8Array(buffer));
        tx.sign([wallet]);
        const sig = await connection.sendTransaction(tx);
        console.log("✅ Sent PumpPortal transaction:", sig);
        return sig;
    } catch (err) {
        console.error("💥 Error sending PumpPortal transaction:", err);
        return null;
    }
}
