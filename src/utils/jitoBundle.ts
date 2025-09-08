// src/utils/jitoBundle.ts
// Jito bundle integration for MEV protection

import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { JitoJsonRpcClient } from 'jito-js-rpc';
// Define our own types since jito-js-rpc doesn't export them properly
interface RpcResponse<T> {
  id: number;
  jsonrpc: string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

interface JitoBundleStatus {
  bundle_id: string;
  status: 'Invalid' | 'Pending' | 'Failed' | 'Landed';
  landed_slot: number | null;
}
import logger from './logger.js';
import { loadBotConfig } from '../config/index.js';
import rpcManager from './rpcManager.js';

// Jito block engine endpoints for different networks
const JITO_BLOCK_ENGINES = {
  mainnet: 'https://mainnet.block-engine.jito.wtf',
  devnet: 'https://devnet.block-engine.jito.wtf',
};

// Default tip amounts in SOL
const DEFAULT_TIP_AMOUNTS = {
  LOW: 0.0001, // 0.1 mSOL - Basic protection
  MEDIUM: 0.0005, // 0.5 mSOL - Standard protection
  HIGH: 0.001, // 1 mSOL - High protection
  AGGRESSIVE: 0.002, // 2 mSOL - Maximum protection
};

export interface JitoBundleConfig {
  enabled: boolean;
  protectionLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'AGGRESSIVE';
  customTipAmount?: number; // Override tip amount in SOL
  maxBundleSize: number;
  timeoutMs: number;
  retryAttempts: number;
  blockEngineUrl?: string;
}

export interface BundleSubmissionResult {
  success: boolean;
  bundleId?: string;
  signature?: string;
  error?: string;
  tipAmount?: number;
  executionTime: number;
}

export interface BundleStatus {
  bundleId: string;
  status: 'pending' | 'inflight' | 'processed' | 'failed' | 'expired';
  signatures: string[];
  error?: string;
}

class JitoBundleManager {
  private client: JitoJsonRpcClient | null = null;
  private config: JitoBundleConfig;
  private initPromise: Promise<void> | null = null;

  constructor() {
    const botConfig = loadBotConfig();
    this.config = {
      enabled: botConfig.mevProtection?.enabled ?? true,
      protectionLevel: botConfig.mevProtection?.protectionLevel ?? 'MEDIUM',
      customTipAmount: botConfig.mevProtection?.customTipAmount,
      maxBundleSize: botConfig.mevProtection?.maxBundleSize ?? 5,
      timeoutMs: botConfig.mevProtection?.timeoutMs ?? 30000,
      retryAttempts: botConfig.mevProtection?.retryAttempts ?? 2,
      blockEngineUrl: botConfig.mevProtection?.blockEngineUrl ?? JITO_BLOCK_ENGINES.mainnet,
    };
  }

  private async initializeClient(): Promise<void> {
    if (this.client) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this._doInitialize();
    await this.initPromise;
  }

  private async _doInitialize(): Promise<void> {
    try {
      // Use the configured block engine URL with fallback
      const blockEngineUrl = this.config.blockEngineUrl || JITO_BLOCK_ENGINES.mainnet;
      this.client = new JitoJsonRpcClient(blockEngineUrl, 'confirmed');

      logger.info('JITO', 'Jito bundle client initialized', {
        blockEngineUrl: this.config.blockEngineUrl,
        protectionLevel: this.config.protectionLevel,
        maxBundleSize: this.config.maxBundleSize,
      });
    } catch (error) {
      logger.error('JITO', 'Failed to initialize Jito client', {
        blockEngineUrl: this.config.blockEngineUrl,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Creates a tip transaction to incentivize bundle inclusion
   */
  private async createTipTransaction(
    payer: Keypair,
    connection: Connection,
    tipAmount?: number,
  ): Promise<VersionedTransaction> {
    const actualTipAmount =
      tipAmount ?? this.config.customTipAmount ?? DEFAULT_TIP_AMOUNTS[this.config.protectionLevel];

    // Get Jito tip accounts (these are well-known addresses)
    const tipAccounts = [
      '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
      'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
      'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
      'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
      'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
      'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
      'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
      '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
    ];

    // Select a random tip account for better distribution
    const randomTipAccount = tipAccounts[Math.floor(Math.random() * tipAccounts.length)];
    const tipReceiver = new PublicKey(randomTipAccount);

    const { blockhash, lastValidBlockHeight } = await rpcManager.executeWithFailover(
      async (conn: Connection) => conn.getLatestBlockhash('confirmed'),
      'getLatestBlockhash',
      2,
    );

    const tipInstruction = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipReceiver,
      lamports: Math.floor(actualTipAmount * LAMPORTS_PER_SOL),
    });

    const messageV0 = new VersionedTransaction({
      instructions: [tipInstruction],
      payer: payer.publicKey,
      recentBlockhash: blockhash,
    } as any);

    messageV0.sign([payer]);

    logger.debug('JITO', 'Created tip transaction', {
      tipAmount: actualTipAmount,
      tipReceiver: randomTipAccount.substring(0, 8) + '...',
      tipLamports: Math.floor(actualTipAmount * LAMPORTS_PER_SOL),
    });

    return messageV0;
  }

  /**
   * Submits a bundle of transactions with MEV protection
   */
  async submitBundle(
    transactions: VersionedTransaction[],
    payer: Keypair,
    connection: Connection,
    customTipAmount?: number,
  ): Promise<BundleSubmissionResult> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      return {
        success: false,
        error: 'Jito bundle submission is disabled',
        executionTime: Date.now() - startTime,
      };
    }

    if (transactions.length === 0) {
      return {
        success: false,
        error: 'No transactions provided for bundle',
        executionTime: Date.now() - startTime,
      };
    }

    if (transactions.length > this.config.maxBundleSize) {
      return {
        success: false,
        error: `Bundle size ${transactions.length} exceeds maximum ${this.config.maxBundleSize}`,
        executionTime: Date.now() - startTime,
      };
    }

    try {
      await this.initializeClient();

      if (!this.client) {
        throw new Error('Jito client not initialized');
      }

      // Create tip transaction
      const tipTx = await this.createTipTransaction(payer, connection, customTipAmount);

      // Build bundle with tip transaction at the end for maximum MEV protection
      const bundleTransactions = [...transactions, tipTx];

      logger.info('JITO', 'Submitting MEV-protected bundle', {
        transactionCount: transactions.length,
        totalBundleSize: bundleTransactions.length,
        protectionLevel: this.config.protectionLevel,
        tipAmount:
          customTipAmount ??
          this.config.customTipAmount ??
          DEFAULT_TIP_AMOUNTS[this.config.protectionLevel],
      });

      // Submit bundle with retry logic
      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= this.config.retryAttempts; attempt++) {
        try {
          // Serialize transactions to base64
          const serializedTransactions = bundleTransactions.map((tx) => {
            return Buffer.from(tx.serialize()).toString('base64');
          });

          // Submit bundle to block engine
          const response = await this.client.sendBundle([serializedTransactions]);

          if (response.error) {
            throw new Error(`Bundle submission failed: ${response.error.message}`);
          }

          if (!response.result) {
            throw new Error('Bundle submission returned no result');
          }

          const bundleId = response.result;

          logger.info('JITO', 'Bundle submitted successfully', {
            bundleId,
            attempt: attempt + 1,
            transactionCount: transactions.length,
            executionTime: Date.now() - startTime,
          });

          // Wait for bundle processing with timeout
          const signature = await this.waitForBundleProcessing(bundleId, this.config.timeoutMs);

          return {
            success: true,
            bundleId,
            signature,
            tipAmount:
              customTipAmount ??
              this.config.customTipAmount ??
              DEFAULT_TIP_AMOUNTS[this.config.protectionLevel],
            executionTime: Date.now() - startTime,
          };
        } catch (error) {
          lastError = error as Error;
          logger.warn('JITO', `Bundle submission attempt ${attempt + 1} failed`, {
            attempt: attempt + 1,
            maxAttempts: this.config.retryAttempts + 1,
            error: lastError.message,
          });

          // Wait before retry (exponential backoff)
          if (attempt < this.config.retryAttempts) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      // All attempts failed
      const errorMessage = `Bundle submission failed after ${this.config.retryAttempts + 1} attempts: ${lastError?.message}`;
      logger.error('JITO', 'Bundle submission completely failed', {
        transactionCount: transactions.length,
        attempts: this.config.retryAttempts + 1,
        finalError: lastError?.message,
        executionTime: Date.now() - startTime,
      });

      return {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = `Bundle submission error: ${(error as Error).message}`;
      logger.error('JITO', 'Bundle submission error', {
        transactionCount: transactions.length,
        error: (error as Error).message,
        stack: (error as Error).stack,
        executionTime: Date.now() - startTime,
      });

      return {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Waits for bundle to be processed and returns the signature
   */
  private async waitForBundleProcessing(
    bundleId: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const startTime = Date.now();
    const endTime = startTime + timeoutMs;

    logger.debug('JITO', 'Waiting for bundle processing', {
      bundleId,
      timeoutMs,
    });

    while (Date.now() < endTime) {
      try {
        if (!this.client) {
          throw new Error('Jito client not available');
        }

        // Check bundle status using inflight bundle statuses
        const inflightResponse = await this.client.getInFlightBundleStatuses([[bundleId]]);

        if (!inflightResponse.error && inflightResponse.result && inflightResponse.result.value) {
          const bundleStatus = inflightResponse.result.value[0];
          if (bundleStatus && bundleStatus.status === 'Landed' && bundleStatus.landed_slot) {
            logger.info('JITO', 'Bundle processed successfully', {
              bundleId,
              landedSlot: bundleStatus.landed_slot,
              waitTime: Date.now() - startTime,
            });

            // Return bundle ID as signature reference
            return bundleId;
          }

          if (bundleStatus && bundleStatus.status === 'Failed') {
            throw new Error(`Bundle failed: ${bundleStatus.status}`);
          }
        }

        // Check bundle statuses for detailed info
        const bundleResponse = await this.client.getBundleStatuses([[bundleId]]);
        if (!bundleResponse.error && bundleResponse.result && bundleResponse.result.value) {
          const detailedStatus = bundleResponse.result.value[0];
          if (detailedStatus && detailedStatus.err) {
            throw new Error(`Bundle execution failed: ${JSON.stringify(detailedStatus.err)}`);
          }
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        logger.warn('JITO', 'Error checking bundle status', {
          bundleId,
          error: (error as Error).message,
        });

        // Continue waiting unless we're near timeout
        if (Date.now() + 2000 > endTime) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    logger.warn('JITO', 'Bundle processing timeout', {
      bundleId,
      waitTime: Date.now() - startTime,
      timeoutMs,
    });

    return undefined;
  }

  /**
   * Gets the current bundle status
   */
  async getBundleStatus(bundleId: string): Promise<BundleStatus | null> {
    try {
      if (!this.client) {
        await this.initializeClient();
      }

      if (!this.client) {
        return null;
      }

      // Check inflight bundle status
      const inflightResponse = await this.client.getInFlightBundleStatuses([[bundleId]]);
      if (!inflightResponse.error && inflightResponse.result && inflightResponse.result.value) {
        const bundleStatus = inflightResponse.result.value[0];
        if (bundleStatus) {
          return {
            bundleId,
            status: bundleStatus.landed_slot
              ? 'processed'
              : bundleStatus.status === 'Failed'
                ? 'failed'
                : 'inflight',
            signatures: [bundleId], // Use bundleId as signature reference
          };
        }
      }

      // Check bundle statuses for more details
      const bundleResponse = await this.client.getBundleStatuses([[bundleId]]);
      if (!bundleResponse.error && bundleResponse.result && bundleResponse.result.value) {
        const detailedStatus = bundleResponse.result.value[0];
        if (detailedStatus) {
          return {
            bundleId,
            status: detailedStatus.err ? 'failed' : 'processed',
            signatures: detailedStatus.transactions || [],
            error: detailedStatus.err ? JSON.stringify(detailedStatus.err) : undefined,
          };
        }
      }

      return {
        bundleId,
        status: 'expired',
        signatures: [],
      };
    } catch (error) {
      logger.error('JITO', 'Error getting bundle status', {
        bundleId,
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Updates configuration
   */
  updateConfig(newConfig: Partial<JitoBundleConfig>): void {
    this.config = { ...this.config, ...newConfig };
    logger.info('JITO', 'Bundle configuration updated', {
      enabled: this.config.enabled,
      protectionLevel: this.config.protectionLevel,
      maxBundleSize: this.config.maxBundleSize,
    });
  }

  /**
   * Gets current configuration
   */
  getConfig(): JitoBundleConfig {
    return { ...this.config };
  }

  /**
   * Health check for Jito service
   */
  async healthCheck(): Promise<{ healthy: boolean; error?: string }> {
    try {
      await this.initializeClient();

      if (!this.client) {
        return { healthy: false, error: 'Client not initialized' };
      }

      // Try a simple RPC call to test connectivity
      // Note: We'll implement a lightweight ping if available in the API
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        error: (error as Error).message,
      };
    }
  }
}

// Export singleton instance
const jitoBundleManager = new JitoBundleManager();
export default jitoBundleManager;

// Export types and constants for external use
export { DEFAULT_TIP_AMOUNTS, JITO_BLOCK_ENGINES };
