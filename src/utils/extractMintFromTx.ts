import { Connection, ParsedInstruction, ParsedTransactionWithMeta, PublicKey } from "@solana/web3.js";
import { sleep } from "./time.js"; // or your local sleep() util

export async function extractMintFromTx(
    connection: Connection,
    signature: string
): Promise<string | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const tx = await connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: "confirmed"
            });

            if (!tx || !tx.transaction || !tx.transaction.message) {
                await sleep(500);
                continue;
            }

            const instructions = tx.transaction.message.instructions as ParsedInstruction[];

            for (const ix of instructions) {
                if (
                    ix.program === "spl-token" &&
                    ix.parsed?.type === "initializeMint"
                ) {
                    const mint = ix.parsed?.info?.mint;
                    try {
                        return new PublicKey(mint).toBase58();
                    } catch {
                        continue;
                    }
                }
            }
        } catch (err) {
            console.warn(`❌ Error while parsing tx ${signature}:`, err);
        }

        await sleep(500);
    }

    console.warn(`❌ No parsed transaction found for: ${signature}`);
    return null;
}
