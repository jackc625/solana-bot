// src/core/scoring.ts

import { PublicKey, Connection } from "@solana/web3.js";
import { connection } from "../utils/solana.js";
import { PumpToken } from "../types/PumpToken.js";
import { getLaunchCount } from "../state/deployerHistory.js";
import { MintLayout, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PROGRAM_ID as TOKEN_METADATA_PROGRAM_ID } from "@metaplex-foundation/mpl-token-metadata";

export interface ScoreResult {
    score: number;
    details: {
        metadata: boolean;
        earlyHolders: boolean;
        launchSpeed: boolean;
        cleanDeployer: boolean;
        hasSocial: boolean;
        largeCap: boolean;
        deployerWhale: boolean;
    };
}

/**
 * Estimate market cap based on simulated LP and assumed supply.
 */
function estimateMarketCap(token: PumpToken): number {
    const liquidity = token.simulatedLp || 0;
    const pricePerToken = liquidity > 0 ? 2 / liquidity : 0;
    const supply = Math.pow(10, token.metadata.decimals ?? 9);
    return supply * pricePerToken;
}

/**
 * Check for an on-chain Metaplex metadata account.
 */
async function hasOnchainMetadata(
    conn: Connection,
    mint: PublicKey
): Promise<boolean> {
    const [pda] = await PublicKey.findProgramAddress(
        [
            Buffer.from("metadata"),
            TOKEN_METADATA_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        TOKEN_METADATA_PROGRAM_ID
    );
    const info = await conn.getAccountInfo(pda);
    return info !== null;
}

export const scoreToken = async (
    token: PumpToken
): Promise<ScoreResult> => {
    const mintPubkey = new PublicKey(token.mint);

    // 1) Metadata existence
    const metadata = await hasOnchainMetadata(connection, mintPubkey);

    // 2) Early holders threshold
    const earlyHolders = token.earlyHolders >= 75;

    // 3) Launch speed threshold
    const launchSpeed = token.launchSpeedSeconds <= 120;

    // 4) Deployer cleanliness: <=3 launches in past hour
    const cleanDeployer = getLaunchCount(token.creator) <= 3;

    // 5) Social presence placeholder
    const hasSocial = false;

    // 6) Market cap minimum
    const largeCap = estimateMarketCap(token) >= 10_000;

    // 7) Deployer whale check: holds <=20% of total supply
    let isWhale = false;
    try {
        const acct = await connection.getAccountInfo(mintPubkey);
        if (acct) {
            const mintInfo = MintLayout.decode(acct.data);
            const rawSupply = mintInfo.supply as bigint;
            const supply = Number(rawSupply) / Math.pow(10, token.metadata.decimals ?? 9);

            const largest = await connection.getTokenLargestAccounts(mintPubkey);
            // derive deployer's ATA
            const [ata] = await PublicKey.findProgramAddress(
                [
                    new PublicKey(token.creator).toBuffer(),
                    TOKEN_PROGRAM_ID.toBuffer(),
                    mintPubkey.toBuffer(),
                ],
                ASSOCIATED_TOKEN_PROGRAM_ID
            );

            const topEntry = largest.value.find((e) => {
                // e.address may be PublicKey or string
                if (typeof e.address === "string") return e.address === ata.toBase58();
                if (e.address instanceof PublicKey) return e.address.equals(ata);
                return false;
            });

            const bal = topEntry?.uiAmount ?? 0;
            isWhale = supply > 0 && bal / supply > 0.2;
        }
    } catch {
        isWhale = false;
    }

    const details = {
        metadata,
        earlyHolders,
        launchSpeed,
        cleanDeployer,
        hasSocial,
        largeCap,
        deployerWhale: !isWhale,
    };

    const score = Object.values(details).filter(Boolean).length;
    return { score, details };
};
