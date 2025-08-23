// src/utils/solana.ts

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { NATIVE_MINT } from "@solana/spl-token";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import rpcManager from "./rpcManager.js";
import logger from "./logger.js";

export const SOL_MINT = NATIVE_MINT;

// Support dynamic switching between environments
const isMainnet = process.env.USE_MAINNET === "true";

const HTTP_URL = isMainnet
    ? process.env.RPC_HTTP_MAINNET
    : process.env.RPC_HTTP_DEVNET;

const WS_URL = isMainnet
    ? process.env.RPC_WS_MAINNET
    : process.env.RPC_WS_DEVNET;

export const RPC_URL = HTTP_URL || process.env.RPC_URL;
export const PRIVATE_KEY = isMainnet
    ? process.env.PRIVATE_KEY_MAINNET
    : process.env.PRIVATE_KEY_DEV;

if (!RPC_URL) {
    throw new Error("❌ RPC_URL is missing from environment variables.");
}

// Legacy connection for backward compatibility (will be replaced by RPC manager)
export const connection = new Connection(RPC_URL!, {
    commitment: "confirmed",
    wsEndpoint: WS_URL!,
});

/**
 * Get the current active connection from RPC manager
 * Falls back to legacy connection if RPC manager not initialized
 */
export const getConnection = (): Connection => {
    try {
        return rpcManager.getConnection();
    } catch (error) {
        logger.warn('SOLANA', 'RPC manager not available, using legacy connection', {
            error: (error as Error).message
        });
        return connection;
    }
};

export const loadWallet = (): Keypair | null => {
    if (!PRIVATE_KEY) {
        console.warn("⚠️ No PRIVATE_KEY provided; running in monitor‑only mode.");
        return null;
    }

    try {
        const decoded = bs58.decode(PRIVATE_KEY!);
        return Keypair.fromSecretKey(decoded);
    } catch (err) {
        throw new Error("❌ Failed to decode PRIVATE_KEY: " + (err as Error).message);
    }
};

export const getWalletAddress = (wallet: Keypair): string =>
    wallet.publicKey.toBase58();

/**
 * Returns the token balance (in whole tokens) for a given mint + owner.
 */
export async function getTokenBalance(
    mint: PublicKey,
    owner: PublicKey
): Promise<number> {
    return await rpcManager.executeWithFailover(
        async (connection: Connection) => {
            const ata = await deriveAssociatedTokenAddress(owner, mint);
            const { amount, decimals } = await getTokenAccountInfo(connection, ata);
            return amount / Math.pow(10, decimals);
        },
        'getTokenBalance',
        3
    ).catch(err => {
        logger.error('SOLANA', 'getTokenBalance failed after all retries', {
            mint: mint.toBase58(),
            owner: owner.toBase58(),
            error: err.message
        });
        return 0;
    });
}

/**
 * Derives the associated token account address for a given wallet and token mint.
 */
export async function deriveAssociatedTokenAddress(
    walletAddress: PublicKey,
    tokenMintAddress: PublicKey
): Promise<PublicKey> {
    const [address] = await PublicKey.findProgramAddress(
        [
            walletAddress.toBuffer(),
            TOKEN_PROGRAM_ID.toBuffer(),
            tokenMintAddress.toBuffer(),
        ],
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return address;
}

/**
 * Fetches parsed token account info (balance and decimals) for a given associated address.
 */
export async function getTokenAccountInfo(
    connection: Connection,
    associatedAddress: PublicKey
): Promise<{ amount: number; decimals: number }> {
    const accountInfo =
        await connection.getParsedAccountInfo(associatedAddress, "confirmed");
    if (!accountInfo.value) {
        throw new Error(`Token account not found for ${associatedAddress.toBase58()}`);
    }
    const parsed = (accountInfo.value.data as any).parsed.info;
    return {
        amount: Number(parsed.tokenAmount.amount),
        decimals: parsed.tokenAmount.decimals,
    };
}