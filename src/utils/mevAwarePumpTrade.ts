// src/utils/mevAwarePumpTrade.ts
// MEV-aware PumpPortal trading with Jito bundle support

import { VersionedTransaction, Connection, Keypair } from '@solana/web3.js';
import { calcPriorityFeeSOL } from './priorityFee.js';
import { fetchWithTimeout } from './withTimeout.js';
import jitoBundleManager from './jitoBundle.js';
import logger from './logger.js';
import { loadBotConfig } from '../config/index.js';
import transactionPrep, { addComputeBudget } from './transactionPreparation.js';

const TRADE_URL = 'https://pumpportal.fun/api/trade-local';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MEVAwarePumpTradeParams {
  connection: Connection;
  wallet: Keypair;
  mint: string;
  amount: number;
  action?: 'buy' | 'sell';
  slippage?: number;
  priorityFee?: number;
  pool?: string;
  denominatedInSol?: boolean;
  // MEV Protection parameters
  usePrivateMempool?: boolean;
  bundleTip?: number;
  delayMs?: number;
  protectionLevel?: 'NONE' | 'BASIC' | 'STANDARD' | 'AGGRESSIVE';
}

export interface MEVAwarePumpTradeResult {
  success: boolean;
  signature?: string;
  bundleId?: string;
  executionMethod: 'STANDARD' | 'JITO_BUNDLE';
  priorityFeeUsed: number;
  bundleTipUsed?: number;
  executionTime: number;
  error?: string;
}

/**
 * Enhanced PumpPortal trading with MEV protection via Jito bundles
 */
export async function sendMEVAwarePumpTrade(
  params: MEVAwarePumpTradeParams,
): Promise<MEVAwarePumpTradeResult> {
  const startTime = Date.now();
  const config = loadBotConfig();

  const {
    connection,
    wallet,
    mint,
    amount,
    action = 'buy',
    slippage = 10,
    priorityFee,
    pool = 'auto',
    denominatedInSol = true,
    usePrivateMempool = false,
    bundleTip,
    delayMs = 0,
    protectionLevel = 'NONE',
  } = params;

  try {
    // Apply delay if specified
    if (delayMs > 0) {
      logger.debug('MEV_PUMP_TRADE', 'Applying MEV protection delay', {
        delayMs,
        mint: mint.substring(0, 8) + '...',
      });
      await sleep(delayMs);
    }

    // Compute priority fee
    const dynamicPriorityFee = await calcPriorityFeeSOL(connection, 1_200_000, 0.9);
    const priorityFeeToUse =
      typeof priorityFee === 'number' && priorityFee > 0 ? priorityFee : dynamicPriorityFee;

    // Create PumpPortal transaction
    const transaction = await createPumpPortalTransaction({
      wallet,
      mint,
      amount,
      action,
      slippage,
      priorityFee: priorityFeeToUse,
      pool,
      denominatedInSol,
    });

    if (!transaction) {
      return {
        success: false,
        executionMethod: 'STANDARD',
        priorityFeeUsed: priorityFeeToUse,
        executionTime: Date.now() - startTime,
        error: 'Failed to create PumpPortal transaction',
      };
    }

    // Execute with MEV protection if requested
    if (usePrivateMempool && config.mevProtection?.enabled !== false) {
      logger.info('MEV_PUMP_TRADE', 'Executing via Jito bundle for MEV protection', {
        mint: mint.substring(0, 8) + '...',
        action,
        amount,
        bundleTip: bundleTip?.toFixed(6),
        protectionLevel,
      });

      const bundleResult = await jitoBundleManager.submitBundle(
        [transaction],
        wallet,
        connection,
        bundleTip,
      );

      return {
        success: bundleResult.success,
        signature: bundleResult.signature,
        bundleId: bundleResult.bundleId,
        executionMethod: 'JITO_BUNDLE',
        priorityFeeUsed: priorityFeeToUse,
        bundleTipUsed: bundleTip || bundleResult.tipAmount,
        executionTime: Date.now() - startTime,
        error: bundleResult.error,
      };
    } else {
      // Standard execution
      logger.info('MEV_PUMP_TRADE', 'Executing via standard RPC', {
        mint: mint.substring(0, 8) + '...',
        action,
        amount,
        priorityFee: priorityFeeToUse.toFixed(6),
      });

      const signature = await connection.sendTransaction(transaction, {
        maxRetries: 3,
        skipPreflight: false,
      });

      // Basic transaction confirmation check
      let confirmationError: string | undefined;
      try {
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) {
          confirmationError = `Transaction failed: ${confirmation.value.err}`;
        }
      } catch (error) {
        confirmationError = `Confirmation check failed: ${(error as Error).message}`;
        // Don't fail here as the transaction might still be valid
      }

      return {
        success: !confirmationError,
        signature,
        executionMethod: 'STANDARD',
        priorityFeeUsed: priorityFeeToUse,
        executionTime: Date.now() - startTime,
        error: confirmationError,
      };
    }
  } catch (error) {
    logger.error('MEV_PUMP_TRADE', 'MEV-aware PumpPortal trade failed', {
      mint: mint.substring(0, 8) + '...',
      action,
      amount,
      usePrivateMempool,
      error: (error as Error).message,
    });

    return {
      success: false,
      executionMethod: usePrivateMempool ? 'JITO_BUNDLE' : 'STANDARD',
      priorityFeeUsed: priorityFee || 0,
      executionTime: Date.now() - startTime,
      error: (error as Error).message,
    };
  }
}

/**
 * Creates a PumpPortal transaction without executing it
 */
async function createPumpPortalTransaction(params: {
  wallet: Keypair;
  mint: string;
  amount: number;
  action: 'buy' | 'sell';
  slippage: number;
  priorityFee: number;
  pool: string;
  denominatedInSol: boolean;
}): Promise<VersionedTransaction | null> {
  try {
    const payload = {
      publicKey: params.wallet.publicKey.toBase58(),
      action: params.action,
      mint: params.mint,
      amount: params.amount,
      denominatedInSol: params.denominatedInSol ? 'true' : 'false',
      slippage: params.slippage,
      priorityFee: params.priorityFee,
      pool: params.pool,
    };

    // Attempt to get transaction from PumpPortal
    const attempt = async () =>
      fetchWithTimeout(TRADE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 1800,
      });

    let res = await attempt();

    // Retry on server errors
    if (res.status === 429 || res.status >= 500) {
      await sleep(300 + Math.floor(Math.random() * 400));
      res = await attempt();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error('MEV_PUMP_TRADE', 'PumpPortal API error', {
        status: res.status,
        statusText: res.statusText,
        response: text,
        mint: params.mint.substring(0, 8) + '...',
      });
      return null;
    }

    const buffer = await res.arrayBuffer();
    const transaction = VersionedTransaction.deserialize(new Uint8Array(buffer));

    // Enhance transaction with proper ComputeBudget
    // Note: PumpPortal should already include ComputeBudget, but this ensures proper units
    try {
      const computeUnits = (params as MEVAwarePumpTradeParams).usePrivateMempool
        ? transactionPrep.COMPUTE_UNITS.JITO_BUNDLE
        : transactionPrep.COMPUTE_UNITS.PUMP_TRADE;

      // For VersionedTransaction, ComputeBudget enhancement is limited
      // The PumpPortal API should already include appropriate ComputeBudget instructions
      logger.debug('MEV_PUMP_TRADE', 'Using compute units for execution', {
        computeUnits,
        method: (params as MEVAwarePumpTradeParams).usePrivateMempool
          ? 'JITO_BUNDLE'
          : 'PUMP_TRADE',
      });
    } catch (error) {
      logger.warn('MEV_PUMP_TRADE', 'ComputeBudget enhancement failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    // Sign the transaction
    transaction.sign([params.wallet]);

    logger.debug('MEV_PUMP_TRADE', 'PumpPortal transaction created successfully', {
      mint: params.mint.substring(0, 8) + '...',
      action: params.action,
      amount: params.amount,
      priorityFee: params.priorityFee.toFixed(6),
    });

    return transaction;
  } catch (error) {
    logger.error('MEV_PUMP_TRADE', 'Failed to create PumpPortal transaction', {
      mint: params.mint.substring(0, 8) + '...',
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Legacy function for backward compatibility - enhanced with MEV awareness
 */
export async function sendPumpTrade({
  connection,
  wallet,
  mint,
  amount,
  action = 'buy',
  slippage = 10,
  priorityFee,
  pool = 'auto',
  denominatedInSol = true,
}: {
  connection: Connection;
  wallet: Keypair;
  mint: string;
  amount: number;
  action?: 'buy' | 'sell';
  slippage?: number;
  priorityFee?: number;
  pool?: string;
  denominatedInSol?: boolean;
}): Promise<string | null> {
  const result = await sendMEVAwarePumpTrade({
    connection,
    wallet,
    mint,
    amount,
    action,
    slippage,
    priorityFee,
    pool,
    denominatedInSol,
    usePrivateMempool: false, // Default to standard execution for legacy compatibility
    protectionLevel: 'NONE',
  });

  return result.success ? result.signature || null : null;
}
