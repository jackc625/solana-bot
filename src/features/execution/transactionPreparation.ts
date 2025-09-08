// src/utils/transactionPreparation.ts
// Pre-creates ATAs and sets ComputeBudget for all transactions to eliminate failures

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccount,
} from '@solana/spl-token';
import logger from './logger.js';
import metricsCollector from './metricsCollector.js';
import { loadBotConfig } from '../config/index.js';
import rpcManager from './rpcManager.js';
import { getConnection } from './solana.js';

const config = loadBotConfig();

// Standard compute units for different operation types
const COMPUTE_UNITS = {
  TOKEN_SWAP: 1_400_000, // Jupiter swaps need high CU
  PUMP_TRADE: 1_200_000, // PumpPortal trades
  ATA_CREATION: 200_000, // Creating ATAs
  SIMPLE_TRANSFER: 150_000, // Basic transfers
  JITO_BUNDLE: 1_600_000, // Jito bundle operations
};

// Priority fee calculation based on network conditions
const PRIORITY_FEE_MULTIPLIERS = {
  LOW_CONGESTION: 1.0,
  MEDIUM_CONGESTION: 2.0,
  HIGH_CONGESTION: 5.0,
  CRITICAL_CONGESTION: 10.0,
};

// Cache for pre-created ATAs to avoid duplicate creation
const ataCache = new Map<string, { address: PublicKey; created: number }>();
const ATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Pre-creates ATAs for common tokens to avoid transaction failures
 */
export class ATAManager {
  private connection: Connection;
  private wallet: Keypair;
  private commonMints: PublicKey[];

  constructor(connection: Connection, wallet: Keypair) {
    this.connection = connection;
    this.wallet = wallet;

    // Common mints to pre-create ATAs for
    this.commonMints = [
      new PublicKey('So11111111111111111111111111111111111111112'), // SOL (WSOL)
      new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), // USDC
      new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'), // USDT
    ];
  }

  /**
   * Pre-creates ATA for a specific mint if it doesn't exist
   */
  async ensureATA(mint: PublicKey, programId: PublicKey = TOKEN_PROGRAM_ID): Promise<PublicKey> {
    const cacheKey = `${mint.toBase58()}-${programId.toBase58()}`;
    const cached = ataCache.get(cacheKey);

    // Check cache first
    if (cached && Date.now() - cached.created < ATA_CACHE_TTL) {
      return cached.address;
    }

    try {
      // Use static import - functions are now available at top level
      // Use getOrCreateAssociatedTokenAccount which handles everything
      const ataInfo = await getOrCreateAssociatedTokenAccount(
        this.connection,
        this.wallet,
        mint,
        this.wallet.publicKey,
        false, // allowOwnerOffCurve
        'confirmed', // commitment
        undefined, // confirmOptions
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

      const ataAddress = ataInfo.address;

      // Cache the result
      ataCache.set(cacheKey, { address: ataAddress, created: Date.now() });

      if (accountInfo) {
        // ATA exists, cache it
        ataCache.set(cacheKey, { address: ataAddress, created: Date.now() });
        return ataAddress;
      }

      // Need to create ATA
      await this.createATA(mint, ataAddress, programId);

      // Cache the newly created ATA
      ataCache.set(cacheKey, { address: ataAddress, created: Date.now() });

      logger.info('ATA_MANAGER', 'Pre-created ATA', {
        mint: mint.toBase58().substring(0, 8) + '...',
        ata: ataAddress.toBase58().substring(0, 8) + '...',
      });

      return ataAddress;
    } catch (error) {
      logger.error('ATA_MANAGER', 'Failed to ensure ATA', {
        mint: mint.toBase58().substring(0, 8) + '...',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }

  /**
   * Creates an ATA with proper ComputeBudget
   */
  private async createATA(
    mint: PublicKey,
    ataAddress: PublicKey,
    programId: PublicKey,
  ): Promise<string> {
    const startTime = Date.now();

    try {
      // Get recent blockhash
      const { blockhash, lastValidBlockHeight } =
        await this.connection.getLatestBlockhash('confirmed');

      // Calculate priority fee
      const priorityFee = await this.calculatePriorityFee(COMPUTE_UNITS.ATA_CREATION);

      // Build transaction
      const transaction = new Transaction();

      // Add ComputeBudget instructions
      transaction.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: COMPUTE_UNITS.ATA_CREATION,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: Math.floor(priorityFee * 1_000_000), // Convert SOL to microlamports
        }),
      );

      // Add ATA creation instruction using static import
      transaction.add(
        createAssociatedTokenAccountInstruction(
          this.wallet.publicKey, // payer
          ataAddress, // ata address
          this.wallet.publicKey, // owner
          mint, // mint
        ),
      );

      // Set blockhash and sign
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      transaction.sign(this.wallet);

      // Send transaction
      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Confirm transaction
      const confirmation = await this.connection.confirmTransaction(
        {
          signature,
          blockhash,
          lastValidBlockHeight,
        },
        'confirmed',
      );

      if (confirmation.value.err) {
        throw new Error(`ATA creation failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      const duration = Date.now() - startTime;
      metricsCollector.recordTradingOperation('route_validation', 'success', duration);

      return signature;
    } catch (error) {
      const duration = Date.now() - startTime;
      metricsCollector.recordTradingOperation('route_validation', 'failure', duration);
      throw error;
    }
  }

  /**
   * Pre-creates ATAs for common tokens
   */
  async preCreateCommonATAs(): Promise<void> {
    logger.info('ATA_MANAGER', 'Pre-creating ATAs for common tokens');

    const promises = this.commonMints.map(async (mint) => {
      try {
        await this.ensureATA(mint);
      } catch (error) {
        logger.warn('ATA_MANAGER', 'Failed to pre-create common ATA', {
          mint: mint.toBase58().substring(0, 8) + '...',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    await Promise.allSettled(promises);
  }

  /**
   * Calculates dynamic priority fee based on network conditions
   */
  private async calculatePriorityFee(computeUnits: number): Promise<number> {
    try {
      // Get recent fee samples
      const samples = await this.connection.getRecentPrioritizationFees();

      if (samples.length === 0) {
        return 0.00001; // Fallback fee
      }

      // Calculate percentiles
      const fees = samples.map((s) => s.prioritizationFee).sort((a, b) => a - b);
      const p50 = fees[Math.floor(fees.length * 0.5)];
      const p75 = fees[Math.floor(fees.length * 0.75)];
      const p95 = fees[Math.floor(fees.length * 0.95)];

      // Determine congestion level
      let multiplier = PRIORITY_FEE_MULTIPLIERS.LOW_CONGESTION;
      if (p95 > 100000) {
        multiplier = PRIORITY_FEE_MULTIPLIERS.CRITICAL_CONGESTION;
      } else if (p75 > 50000) {
        multiplier = PRIORITY_FEE_MULTIPLIERS.HIGH_CONGESTION;
      } else if (p50 > 10000) {
        multiplier = PRIORITY_FEE_MULTIPLIERS.MEDIUM_CONGESTION;
      }

      // Calculate fee in SOL
      const baseFee = Math.max(p75, 1000); // Use 75th percentile, minimum 1000 micro-lamports
      const totalMicroLamports = baseFee * multiplier * (computeUnits / 1_000_000);

      return Math.min(totalMicroLamports / 1_000_000 / LAMPORTS_PER_SOL, 0.01); // Cap at 0.01 SOL
    } catch (error) {
      logger.warn('ATA_MANAGER', 'Failed to calculate priority fee', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return 0.00001; // Fallback fee
    }
  }
}

/**
 * Enhances a transaction with proper ComputeBudget instructions
 */
export async function addComputeBudget(
  transaction: Transaction | VersionedTransaction,
  computeUnits: number,
  connection?: Connection,
): Promise<void> {
  const conn = connection || getConnection();
  const ataManager = new ATAManager(conn, {} as Keypair); // Temporary for priority fee calc

  const priorityFee = await (ataManager as any).calculatePriorityFee(computeUnits);

  if (transaction instanceof Transaction) {
    // Add ComputeBudget instructions to legacy transaction
    const computeInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.floor(priorityFee * 1_000_000),
      }),
    ];

    // Insert at the beginning
    transaction.instructions.unshift(...computeInstructions);
  } else {
    // For VersionedTransaction, we need to rebuild the message
    logger.warn('COMPUTE_BUDGET', 'VersionedTransaction ComputeBudget enhancement not implemented');
  }
}

/**
 * Transaction preparation utilities
 */
export const transactionPrep = {
  COMPUTE_UNITS,

  /**
   * Initialize ATA manager for a wallet
   */
  createATAManager(connection: Connection, wallet: Keypair): ATAManager {
    return new ATAManager(connection, wallet);
  },

  /**
   * Pre-warm common ATAs and setup
   */
  async initialize(connection: Connection, wallet: Keypair): Promise<void> {
    const manager = new ATAManager(connection, wallet);
    await manager.preCreateCommonATAs();
    logger.info('TRANSACTION_PREP', 'Transaction preparation initialized');
  },
};

export default transactionPrep;
