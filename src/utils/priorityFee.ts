// src/utils/priorityFee.ts
import { Connection } from "@solana/web3.js";
import networkHealthMonitor from "./networkHealth.js";
import logger from "./logger.js";

/**
 * Recommend a priority fee in SOL for a given compute-unit target.
 * - Pulls recent prioritization fees
 * - Uses a percentile (default 90th) for robustness
 * - Converts microLamports-per-CU → lamports → SOL using the target CU budget
 *
 * Example: with 1.2M CU and ~5_000 µLamports/CU ⇒ ~0.000006 SOL fee
 */
export async function calcPriorityFeeSOL(
    connection: Connection,
    targetUnits = 1_200_000,   // reasonable ceiling for these swaps
    pct = 0.90                 // 90th percentile of recent fees
): Promise<number> {
    try {
        const fees = await connection.getRecentPrioritizationFees(); // web3 >= 1.95
        if (!fees || fees.length === 0) return 0.00001; // fallback
        const xs = fees.map(f => f.prioritizationFee).sort((a, b) => a - b); // µLamports/CU
        const idx = Math.min(xs.length - 1, Math.floor(xs.length * pct));
        const microLamportsPerCU = Math.max(500, xs[idx] || 1000); // floor to 500 µLamports/CU
        const lamports = (microLamportsPerCU * targetUnits) / 1_000_000;     // µLamports→Lamports
        const sol = lamports / 1_000_000_000;                                // Lamports→SOL
        
        // SAFETY-005: Validate priority fee for anomalies
        const isValidFee = networkHealthMonitor.validatePriorityFee(sol);
        if (!isValidFee) {
            logger.warn('PRIORITY_FEE', 'Priority fee validation failed, using fallback', {
                calculatedFee: sol,
                fallbackFee: 0.0001
            });
            return 0.0001; // Safe fallback
        }
        
        return sol;
    } catch {
        return 0.00001; // tiny but non-zero fallback
    }
}
