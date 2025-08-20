// src/core/scoring.ts

import { PublicKey, Connection } from "@solana/web3.js";
import { connection } from "../utils/solana.js";
import { PumpToken } from "../types/PumpToken.js";
import { getLaunchCount } from "../state/deployerHistory.js";
import { MintLayout, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { getCurrentPriceViaJupiter } from "./trading.js";
import { loadWallet } from "../utils/solana.js";
import logger from "../utils/logger.js";
import socialVerificationService from "../utils/socialVerification.js";

// Token Metadata Program ID constant
const TOKEN_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

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
        marketCapSol?: number | null;
        socialVerification?: {
            verified: boolean;
            socialScore: number;
            hasTwitter: boolean;
            hasWebsite: boolean;
            trustStatus: string;
            riskFlags: string[];
        };
    };
}

/**
 * Get actual token supply from on-chain mint account
 */
async function getActualTokenSupply(
    conn: Connection,
    mintAddress: PublicKey,
    decimals: number
): Promise<number | null> {
    try {
        const mintInfo = await conn.getAccountInfo(mintAddress);
        if (!mintInfo) {
            logger.warn('SCORING', 'Mint account not found for supply calculation', { 
                mint: mintAddress.toBase58().substring(0, 8) + '...' 
            });
            return null;
        }

        const decoded = MintLayout.decode(mintInfo.data);
        const rawSupply = decoded.supply as bigint;
        const actualSupply = Number(rawSupply) / Math.pow(10, decimals);
        
        logger.debug('SCORING', 'Token supply fetched', {
            mint: mintAddress.toBase58().substring(0, 8) + '...',
            rawSupply: rawSupply.toString(),
            actualSupply,
            decimals
        });
        
        return actualSupply;
    } catch (error) {
        logger.error('SCORING', 'Failed to fetch token supply', {
            mint: mintAddress.toBase58().substring(0, 8) + '...',
            decimals
        }, error);
        return null;
    }
}

/**
 * Calculate market cap using actual on-chain supply and current market price
 */
async function calculateMarketCap(token: PumpToken): Promise<number | null> {
    try {
        const mintPubkey = new PublicKey(token.mint);
        const decimals = token.metadata.decimals ?? 9;
        
        // Validate decimals are reasonable
        if (decimals < 0 || decimals > 18) {
            logger.warn('SCORING', 'Invalid token decimals for market cap calculation', {
                mint: token.mint.substring(0, 8) + '...',
                decimals
            });
            return null;
        }
        
        // Get actual token supply from on-chain
        const actualSupply = await getActualTokenSupply(connection, mintPubkey, decimals);
        if (!actualSupply || actualSupply <= 0) {
            logger.warn('SCORING', 'Invalid token supply for market cap calculation', {
                mint: token.mint.substring(0, 8) + '...',
                supply: actualSupply
            });
            return null;
        }
        
        // Validate supply is reasonable (not suspiciously large)
        const MAX_REASONABLE_SUPPLY = 1e15; // 1 quadrillion tokens max
        if (actualSupply > MAX_REASONABLE_SUPPLY) {
            logger.warn('SCORING', 'Token supply too large - possible calculation error', {
                mint: token.mint.substring(0, 8) + '...',
                supply: actualSupply,
                maxReasonable: MAX_REASONABLE_SUPPLY
            });
            return null;
        }
        
        // Get current market price via Jupiter (SOL per token)
        const wallet = loadWallet();
        if (!wallet) {
            logger.warn('SCORING', 'No wallet available for price fetching', {
                mint: token.mint.substring(0, 8) + '...'
            });
            return null;
        }
        
        const priceData = await getCurrentPriceViaJupiter(token.mint, 0.01, wallet); // Use 0.01 SOL probe
        if (!priceData || !priceData.price || priceData.price <= 0) {
            logger.debug('SCORING', 'No valid price data for market cap calculation', {
                mint: token.mint.substring(0, 8) + '...',
                priceData
            });
            return null;
        }
        
        // Validate price is reasonable
        const MIN_REASONABLE_PRICE = 1e-15; // Extremely small but not zero
        const MAX_REASONABLE_PRICE = 1e6;   // 1M SOL per token (unrealistic)
        if (priceData.price < MIN_REASONABLE_PRICE || priceData.price > MAX_REASONABLE_PRICE) {
            logger.warn('SCORING', 'Token price outside reasonable bounds', {
                mint: token.mint.substring(0, 8) + '...',
                price: priceData.price,
                minReasonable: MIN_REASONABLE_PRICE,
                maxReasonable: MAX_REASONABLE_PRICE
            });
            return null;
        }
        
        // Market cap = total supply × price per token (in SOL)
        const marketCapSol = actualSupply * priceData.price;
        
        // Validate market cap is reasonable
        const MAX_REASONABLE_MARKET_CAP = 1e8; // 100M SOL (~$20B at $200/SOL)
        if (marketCapSol > MAX_REASONABLE_MARKET_CAP) {
            logger.warn('SCORING', 'Calculated market cap unreasonably large', {
                mint: token.mint.substring(0, 8) + '...',
                marketCapSol,
                maxReasonable: MAX_REASONABLE_MARKET_CAP,
                supply: actualSupply,
                price: priceData.price
            });
            return null;
        }
        
        logger.debug('SCORING', 'Market cap calculated successfully', {
            mint: token.mint.substring(0, 8) + '...',
            actualSupply,
            pricePerToken: priceData.price,
            marketCapSol,
            decimals
        });
        
        return marketCapSol;
        
    } catch (error) {
        logger.error('SCORING', 'Market cap calculation failed', {
            mint: token.mint.substring(0, 8) + '...'
        }, error);
        return null;
    }
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

    // 5) SAFETY-007: Enhanced social presence verification
    let hasSocial = false;
    let socialVerification: any = undefined;
    
    try {
        const socialResult = await socialVerificationService.verifySocialPresence(token);
        
        // Consider social presence verified if score >= 3 and no critical risk flags
        const criticalFlags = socialResult.details.riskFlags.filter(flag => 
            flag.includes('BLACKLISTED') || flag.includes('NO_SOCIAL_PRESENCE')
        );
        
        hasSocial = socialResult.score >= 3 && criticalFlags.length === 0;
        
        // Store social verification details for debugging
        socialVerification = {
            verified: socialResult.verified,
            socialScore: socialResult.score,
            hasTwitter: socialResult.details.hasTwitter,
            hasWebsite: socialResult.details.hasWebsite,
            trustStatus: socialResult.details.trustedListStatus,
            riskFlags: socialResult.details.riskFlags
        };
        
        logger.info('SCORING', 'Social verification completed', {
            mint: token.mint.substring(0, 8) + '...',
            verified: socialResult.verified,
            socialScore: socialResult.score,
            hasSocial,
            riskFlags: socialResult.details.riskFlags.length
        });
        
    } catch (error) {
        logger.warn('SCORING', 'Social verification failed, using fallback', {
            mint: token.mint.substring(0, 8) + '...',
            error: (error as Error).message
        });
        
        // Fallback to basic social presence detection
        hasSocial = !!(token.metadata.uri || token.metadata.description);
    }

    // 6) Market cap minimum (using proper calculation)
    const marketCapSol = await calculateMarketCap(token);
    const largeCap = marketCapSol !== null && marketCapSol >= 10; // 10 SOL minimum market cap (~$2000 at $200/SOL)

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
        marketCapSol,
        socialVerification // Include social verification details
    };

    // Only count boolean values for score (exclude marketCapSol)
    const booleanDetails = {
        metadata,
        earlyHolders,
        launchSpeed,
        cleanDeployer,
        hasSocial,
        largeCap,
        deployerWhale: !isWhale,
    };
    const score = Object.values(booleanDetails).filter(Boolean).length;
    return { score, details };
};
