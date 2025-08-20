// src/utils/lpLockVerification.ts
// LP lock verification system for Raydium and Orca pools

import { Connection, PublicKey, AccountInfo } from "@solana/web3.js";
import { MintLayout, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import logger from "./logger.js";

// Common burn address on Solana
const BURN_ADDRESS = new PublicKey("1nc1nerator11111111111111111111111111111111");

// Known Raydium program IDs
const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
const RAYDIUM_CLMM = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUQpMAS4k3aSLM3n5h6");

// Known Orca program IDs  
const ORCA_WHIRLPOOL = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

// Common token vesting/lock programs
const KNOWN_LOCK_PROGRAMS = [
    new PublicKey("11111111111111111111111111111111"), // System program (for escrow accounts)
    new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), // Token program (for locked accounts)
    // Add more known vesting/lock program IDs as needed
];

export interface LpLockStatus {
    isLocked: boolean;
    lockType: 'burned' | 'vesting_locked' | 'time_locked' | 'not_locked';
    lockPercentage: number; // Percentage of LP tokens that are locked/burned
    totalSupply: number;
    burnedAmount: number;
    lockedAmount: number;
    estimatedUnlockTime?: number; // Unix timestamp
    lockProgram?: string;
    details: string;
}

export interface LpLockConfig {
    minLockPercentage: number; // Minimum % of LP tokens that must be locked (default 80%)
    minLockDurationHours: number; // Minimum lock duration in hours (default 24)
    acceptBurnedLp: boolean; // Accept burned LP as sufficient lock (default true)
    acceptVestingLock: boolean; // Accept vesting/time locks (default true)
}

/**
 * Verify LP lock status for a given LP token mint
 */
export async function verifyLpLockStatus(
    connection: Connection,
    lpMintAddress: PublicKey,
    config: LpLockConfig
): Promise<LpLockStatus> {
    try {
        logger.info("LP_LOCK", `Verifying LP lock status for mint: ${lpMintAddress.toBase58()}`);

        // 1. Get LP token mint information
        const mintAccount = await connection.getAccountInfo(lpMintAddress);
        if (!mintAccount) {
            throw new Error("LP mint account not found");
        }
        
        const mintInfo = MintLayout.decode(mintAccount.data);
        const totalSupply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);

        if (totalSupply === 0) {
            return {
                isLocked: true,
                lockType: 'burned',
                lockPercentage: 100,
                totalSupply: 0,
                burnedAmount: 0,
                lockedAmount: 0,
                details: "All LP tokens have been burned (total supply = 0)"
            };
        }

        // 2. Get largest LP token holders
        const largestAccounts = await connection.getTokenLargestAccounts(lpMintAddress);
        
        let burnedAmount = 0;
        let lockedAmount = 0;
        let lockProgram: string | undefined;
        let estimatedUnlockTime: number | undefined;

        // 3. Analyze each large holder
        for (const accountInfo of largestAccounts.value) {
            if (!accountInfo.address || !accountInfo.uiAmount) continue;

            const holderAmount = accountInfo.uiAmount;
            const accountPubkey = accountInfo.address;

            // Check if tokens are burned
            if (accountPubkey.equals(BURN_ADDRESS)) {
                burnedAmount += holderAmount;
                logger.info("LP_LOCK", `Found burned LP tokens: ${holderAmount} (${(holderAmount/totalSupply*100).toFixed(2)}%)`);
                continue;
            }

            // Check if account is a lock/vesting program
            const accountData = await connection.getAccountInfo(accountPubkey);
            if (accountData) {
                const isLockAccount = await analyzeLockAccount(connection, accountPubkey, accountData);
                if (isLockAccount.isLocked) {
                    lockedAmount += holderAmount;
                    lockProgram = isLockAccount.program;
                    estimatedUnlockTime = isLockAccount.unlockTime;
                    logger.info("LP_LOCK", `Found locked LP tokens: ${holderAmount} (${(holderAmount/totalSupply*100).toFixed(2)}%) in ${isLockAccount.program}`);
                }
            }
        }

        // 4. Calculate lock percentage and determine status
        const totalLocked = burnedAmount + lockedAmount;
        const lockPercentage = (totalLocked / totalSupply) * 100;

        let lockType: LpLockStatus['lockType'] = 'not_locked';
        if (burnedAmount > 0 && lockedAmount === 0) {
            lockType = 'burned';
        } else if (lockedAmount > 0 && burnedAmount === 0) {
            lockType = estimatedUnlockTime ? 'time_locked' : 'vesting_locked';
        } else if (burnedAmount > 0 && lockedAmount > 0) {
            lockType = 'burned'; // Prefer burned classification when both exist
        }

        // 5. Determine if lock meets requirements
        const meetsPercentageRequirement = lockPercentage >= config.minLockPercentage;
        const meetsDurationRequirement = !estimatedUnlockTime || 
            (estimatedUnlockTime - Date.now()/1000) >= (config.minLockDurationHours * 3600);

        const isLocked = meetsPercentageRequirement && 
                        (lockType === 'burned' && config.acceptBurnedLp) ||
                        (lockType !== 'burned' && config.acceptVestingLock && meetsDurationRequirement);

        const result: LpLockStatus = {
            isLocked,
            lockType,
            lockPercentage,
            totalSupply,
            burnedAmount,
            lockedAmount,
            estimatedUnlockTime,
            lockProgram,
            details: generateLockDetails(lockPercentage, lockType, totalSupply, burnedAmount, lockedAmount, config)
        };

        logger.info("LP_LOCK", `LP lock verification result: ${isLocked ? 'PASSED' : 'FAILED'}`, {
            mint: lpMintAddress.toBase58(),
            lockPercentage: lockPercentage.toFixed(2),
            lockType,
            totalSupply: totalSupply.toFixed(6)
        });

        return result;

    } catch (error) {
        logger.error("LP_LOCK", `LP lock verification failed for ${lpMintAddress.toBase58()}`, {
            error: (error as Error)?.message || error
        });

        return {
            isLocked: false,
            lockType: 'not_locked',
            lockPercentage: 0,
            totalSupply: 0,
            burnedAmount: 0,
            lockedAmount: 0,
            details: `LP lock verification error: ${(error as Error)?.message || error}`
        };
    }
}

/**
 * Analyze an account to determine if it's a lock/vesting contract
 */
async function analyzeLockAccount(
    connection: Connection,
    accountPubkey: PublicKey,
    accountData: AccountInfo<Buffer>
): Promise<{ isLocked: boolean; program?: string; unlockTime?: number }> {
    try {
        // Check if account is owned by a known lock program
        const owner = accountData.owner;
        
        // Check for system program (escrow accounts)
        if (owner.equals(new PublicKey("11111111111111111111111111111111"))) {
            // Could be an escrow account - need more analysis
            return { isLocked: false }; // Conservative approach
        }

        // Check for token program ownership (could be a locked token account)
        if (owner.equals(TOKEN_PROGRAM_ID)) {
            // This is a regular token account - check if it has authority restrictions
            return await analyzeTokenAccountLock(connection, accountPubkey);
        }

        // Check for known vesting programs
        for (const lockProgram of KNOWN_LOCK_PROGRAMS) {
            if (owner.equals(lockProgram)) {
                return { 
                    isLocked: true, 
                    program: lockProgram.toBase58(),
                    unlockTime: await estimateUnlockTime(connection, accountPubkey, owner)
                };
            }
        }

        // Unknown program - conservative approach
        return { isLocked: false };

    } catch (error) {
        logger.warn("LP_LOCK", `Error analyzing lock account ${accountPubkey.toBase58()}`, {
            error: (error as Error)?.message || error
        });
        return { isLocked: false };
    }
}

/**
 * Analyze a token account to see if it has lock characteristics
 */
async function analyzeTokenAccountLock(
    connection: Connection,
    tokenAccount: PublicKey
): Promise<{ isLocked: boolean; program?: string; unlockTime?: number }> {
    try {
        // Get parsed token account info
        const accountInfo = await connection.getParsedAccountInfo(tokenAccount);
        
        if (accountInfo.value?.data && 'parsed' in accountInfo.value.data) {
            const parsedData = accountInfo.value.data.parsed;
            
            if (parsedData.type === 'account') {
                const accountData = parsedData.info;
                
                // Check if account has no authority (frozen/locked)
                if (!accountData.owner || accountData.owner === tokenAccount.toBase58()) {
                    return { 
                        isLocked: true, 
                        program: "token_account_no_authority" 
                    };
                }

                // Check if account is frozen
                if (accountData.state === 'frozen') {
                    return { 
                        isLocked: true, 
                        program: "token_account_frozen" 
                    };
                }
            }
        }

        return { isLocked: false };

    } catch (error) {
        return { isLocked: false };
    }
}

/**
 * Estimate unlock time for a vesting/lock account
 */
async function estimateUnlockTime(
    connection: Connection,
    lockAccount: PublicKey,
    lockProgram: PublicKey
): Promise<number | undefined> {
    // This would need to be implemented per lock program
    // Each vesting program has different data structures
    // For now, return undefined (unknown unlock time)
    return undefined;
}

/**
 * Generate human-readable details about the lock status
 */
function generateLockDetails(
    lockPercentage: number,
    lockType: LpLockStatus['lockType'],
    totalSupply: number,
    burnedAmount: number,
    lockedAmount: number,
    config: LpLockConfig
): string {
    if (lockPercentage === 0) {
        return "No LP tokens are locked or burned - HIGH RUG PULL RISK";
    }

    let details = `${lockPercentage.toFixed(2)}% of LP tokens are secured`;

    if (burnedAmount > 0 && lockedAmount > 0) {
        details += ` (${(burnedAmount/totalSupply*100).toFixed(2)}% burned, ${(lockedAmount/totalSupply*100).toFixed(2)}% locked)`;
    } else if (burnedAmount > 0) {
        details += ` (${(burnedAmount/totalSupply*100).toFixed(2)}% burned)`;
    } else if (lockedAmount > 0) {
        details += ` (${(lockedAmount/totalSupply*100).toFixed(2)}% locked)`;
    }

    if (lockPercentage < config.minLockPercentage) {
        details += ` - INSUFFICIENT (requires ${config.minLockPercentage}%+)`;
    } else {
        details += " - SUFFICIENT";
    }

    return details;
}

/**
 * Detect AMM type from pool/token information
 */
export function detectAmmType(poolAddress?: string): 'raydium' | 'orca' | 'unknown' {
    if (!poolAddress) return 'unknown';

    try {
        const pubkey = new PublicKey(poolAddress);
        
        // This is a simplified detection - in practice you'd need to check
        // program ownership or use AMM-specific pool identification
        
        // For now, return unknown and let the general verification handle it
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * High-level function to verify LP lock for a token
 */
export async function verifyTokenLpLock(
    connection: Connection,
    tokenMint: PublicKey,
    poolInfo?: { lpMint?: PublicKey; poolAddress?: string },
    config: Partial<LpLockConfig> = {}
): Promise<LpLockStatus> {
    const defaultConfig: LpLockConfig = {
        minLockPercentage: 80, // 80% of LP tokens must be locked
        minLockDurationHours: 24, // 24 hour minimum lock
        acceptBurnedLp: true,
        acceptVestingLock: true,
        ...config
    };

    if (poolInfo?.lpMint) {
        // We have the LP mint directly
        return await verifyLpLockStatus(connection, poolInfo.lpMint, defaultConfig);
    }

    // If we don't have LP mint, we'd need to derive it from pool information
    // This would require AMM-specific logic to find the LP token mint
    logger.warn("LP_LOCK", `No LP mint provided for token ${tokenMint.toBase58()}, cannot verify lock status`);
    
    return {
        isLocked: false,
        lockType: 'not_locked',
        lockPercentage: 0,
        totalSupply: 0,
        burnedAmount: 0,
        lockedAmount: 0,
        details: "Cannot verify LP lock: LP mint address not available"
    };
}

export default {
    verifyLpLockStatus,
    verifyTokenLpLock,
    detectAmmType
};