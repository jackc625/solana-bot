// src/utils/onChainLpReserves.ts
// On-chain LP reserves verification - direct blockchain data for accurate liquidity analysis

import { Connection, PublicKey, AccountInfo, ParsedAccountData } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, AccountLayout, MintLayout } from '@solana/spl-token';
import logger from './logger.js';
import { getConnection } from './solana.js';
import metricsCollector from './metricsCollector.js';
import JSBIImport from 'jsbi';

const JSBI: any = JSBIImport;

// Common DEX program IDs for LP pool detection
const DEX_PROGRAMS = {
  RAYDIUM_V4: new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'),
  RAYDIUM_V3: new PublicKey('27haf8L6oxUeXrHrgEgsexjSY5hbVUWEmvv9Nyxg8vQv'),
  ORCA_V1: new PublicKey('9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP'),
  ORCA_V2: new PublicKey('DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1'),
  SERUM_V3: new PublicKey('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin'),
  METEORA: new PublicKey('24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi'),
  PUMP_FUN: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  BONKSWAP: new PublicKey('BSwp6bEBihVLdqJRKGgzjcGLHkcTuzmSo1TQkHepzH8p'),
};

// Well-known mint addresses
const COMMON_MINTS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
  RAY: new PublicKey('4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R'),
  ORCA: new PublicKey('orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'),
};

export interface OnChainLpData {
  poolAddress: PublicKey;
  tokenMint: PublicKey;
  quoteMint: PublicKey;
  tokenReserves: number;
  quoteReserves: number;
  tokenDecimals: number;
  quoteDecimals: number;
  poolOwner: PublicKey;
  dexProgram: PublicKey;
  dexName: string;
  totalLpTokens: number;
  lpPrice: number;
  depth: {
    token: number;
    quote: number;
    totalSol: number;
  };
  priceImpact: {
    for1Sol: number;
    for5Sol: number;
    for10Sol: number;
  };
  healthScore: number; // 0-100 based on reserves, balance, etc.
  lastUpdated: number;
}

export interface LpPoolSearchResult {
  found: boolean;
  pools: OnChainLpData[];
  totalLiquidity: number;
  bestPool?: OnChainLpData;
  aggregatedDepth: {
    token: number;
    quote: number;
    totalSol: number;
  };
  riskAnalysis: {
    level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
    factors: string[];
    recommendations: string[];
  };
}

class OnChainLpReservesAnalyzer {
  private connection: Connection;
  private cache: Map<string, { data: LpPoolSearchResult; timestamp: number }>;
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds cache
  private readonly MAX_POOLS_PER_TOKEN = 10;
  private readonly MIN_RESERVE_SOL = 0.1; // Minimum 0.1 SOL to consider valid

  constructor(connection?: Connection) {
    this.connection = connection || getConnection();
    this.cache = new Map();

    // Clean cache periodically
    setInterval(() => this.cleanCache(), 60_000);
  }

  /**
   * Find and analyze all LP pools for a given token
   */
  async findLpPools(tokenMint: PublicKey): Promise<LpPoolSearchResult> {
    const cacheKey = tokenMint.toBase58();
    const cached = this.cache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    const startTime = Date.now();

    try {
      logger.debug('LP_RESERVES', 'Searching for LP pools', {
        tokenMint: tokenMint.toBase58().substring(0, 8) + '...',
      });

      // Search for pools across different DEXes
      const poolPromises = Object.entries(DEX_PROGRAMS).map(([dexName, programId]) =>
        this.searchPoolsForDex(tokenMint, programId, dexName),
      );

      const poolResults = await Promise.allSettled(poolPromises);
      const allPools: OnChainLpData[] = [];

      // Collect successful results
      for (let i = 0; i < poolResults.length; i++) {
        const result = poolResults[i];
        if (result.status === 'fulfilled' && result.value.length > 0) {
          allPools.push(...result.value);
        } else if (result.status === 'rejected') {
          logger.debug('LP_RESERVES', 'Pool search failed for DEX', {
            dex: Object.keys(DEX_PROGRAMS)[i],
            error: result.reason.message,
          });
        }
      }

      // Sort pools by total liquidity and health score
      allPools.sort((a, b) => b.depth.totalSol * b.healthScore - a.depth.totalSol * a.healthScore);

      // Take top pools only
      const topPools = allPools.slice(0, this.MAX_POOLS_PER_TOKEN);

      // Calculate aggregated metrics
      const totalLiquidity = topPools.reduce((sum, pool) => sum + pool.depth.totalSol, 0);
      const bestPool = topPools[0];

      // Aggregate depth across all pools
      const aggregatedDepth = topPools.reduce(
        (acc, pool) => ({
          token: acc.token + pool.depth.token,
          quote: acc.quote + pool.depth.quote,
          totalSol: acc.totalSol + pool.depth.totalSol,
        }),
        { token: 0, quote: 0, totalSol: 0 },
      );

      // Risk analysis
      const riskAnalysis = this.analyzePoolRisks(topPools, totalLiquidity);

      const result: LpPoolSearchResult = {
        found: topPools.length > 0,
        pools: topPools,
        totalLiquidity,
        bestPool,
        aggregatedDepth,
        riskAnalysis,
      };

      // Cache the result
      this.cache.set(cacheKey, { data: result, timestamp: Date.now() });

      const duration = Date.now() - startTime;
      metricsCollector.recordTradingOperation('route_validation', 'success', duration);

      logger.info('LP_RESERVES', 'LP pool search completed', {
        tokenMint: tokenMint.toBase58().substring(0, 8) + '...',
        poolsFound: topPools.length,
        totalLiquidity: totalLiquidity.toFixed(4),
        bestPoolDex: bestPool?.dexName || 'none',
        duration: `${duration}ms`,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      metricsCollector.recordTradingOperation('route_validation', 'failure', duration);

      logger.error('LP_RESERVES', 'Failed to find LP pools', {
        tokenMint: tokenMint.toBase58().substring(0, 8) + '...',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Return empty result on error
      return {
        found: false,
        pools: [],
        totalLiquidity: 0,
        aggregatedDepth: { token: 0, quote: 0, totalSol: 0 },
        riskAnalysis: {
          level: 'EXTREME',
          factors: ['Failed to fetch on-chain data'],
          recommendations: ['Skip this token - liquidity data unavailable'],
        },
      };
    }
  }

  /**
   * Search for pools on a specific DEX
   */
  private async searchPoolsForDex(
    tokenMint: PublicKey,
    programId: PublicKey,
    dexName: string,
  ): Promise<OnChainLpData[]> {
    try {
      // Get all token accounts for this mint
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        programId,
        { mint: tokenMint },
        'confirmed',
      );

      const pools: OnChainLpData[] = [];

      for (const account of tokenAccounts.value) {
        try {
          const poolData = await this.analyzePoolAccount(
            account.pubkey,
            account.account,
            tokenMint,
            programId,
            dexName,
          );

          if (poolData && poolData.depth.totalSol >= this.MIN_RESERVE_SOL) {
            pools.push(poolData);
          }
        } catch (error) {
          // Skip individual pool analysis errors
          logger.debug('LP_RESERVES', 'Failed to analyze pool account', {
            poolAccount: account.pubkey.toBase58(),
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return pools;
    } catch (error) {
      logger.debug('LP_RESERVES', 'DEX search failed', {
        dex: dexName,
        programId: programId.toBase58(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return [];
    }
  }

  /**
   * Analyze a specific pool account to extract liquidity data
   */
  private async analyzePoolAccount(
    poolAddress: PublicKey,
    accountInfo: AccountInfo<ParsedAccountData>,
    tokenMint: PublicKey,
    programId: PublicKey,
    dexName: string,
  ): Promise<OnChainLpData | null> {
    try {
      const parsedData = accountInfo.data.parsed;
      if (!parsedData || !parsedData.info) {
        return null;
      }

      const tokenAmount = parsedData.info.tokenAmount;
      if (!tokenAmount || !tokenAmount.uiAmount) {
        return null;
      }

      // Find the paired quote token account (usually SOL/USDC)
      const pairedAccounts = await this.findPairedQuoteAccount(poolAddress, tokenMint);
      if (!pairedAccounts) {
        return null;
      }

      // Calculate reserves and liquidity metrics
      const tokenReserves = tokenAmount.uiAmount;
      const quoteReserves = pairedAccounts.quoteAmount;
      const tokenDecimals = tokenAmount.decimals;
      const quoteDecimals = pairedAccounts.quoteDecimals;

      // Convert quote reserves to SOL equivalent
      let quoteInSol = quoteReserves;
      if (
        pairedAccounts.quoteMint.equals(COMMON_MINTS.USDC) ||
        pairedAccounts.quoteMint.equals(COMMON_MINTS.USDT)
      ) {
        // Assume 1 SOL ≈ $150 for rough conversion (this is imprecise but gives relative scale)
        quoteInSol = quoteReserves / 150;
      }

      // Calculate price and depth metrics
      const lpPrice = quoteInSol / tokenReserves; // Price in SOL per token
      const totalSolValue = quoteInSol * 2; // Both sides of the pair

      // Estimate price impact for different trade sizes
      const priceImpact = this.calculatePriceImpact(tokenReserves, quoteInSol);

      // Health score based on balance, reserves, and age
      const healthScore = this.calculatePoolHealthScore(
        tokenReserves,
        quoteInSol,
        accountInfo.lamports,
      );

      return {
        poolAddress,
        tokenMint,
        quoteMint: pairedAccounts.quoteMint,
        tokenReserves,
        quoteReserves,
        tokenDecimals,
        quoteDecimals,
        poolOwner: accountInfo.owner,
        dexProgram: programId,
        dexName,
        totalLpTokens: 0, // Would need additional lookup
        lpPrice,
        depth: {
          token: tokenReserves,
          quote: quoteReserves,
          totalSol: totalSolValue,
        },
        priceImpact,
        healthScore,
        lastUpdated: Date.now(),
      };
    } catch (error) {
      logger.debug('LP_RESERVES', 'Pool analysis failed', {
        poolAddress: poolAddress.toBase58(),
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Find the paired quote token account for a pool
   */
  private async findPairedQuoteAccount(
    poolAddress: PublicKey,
    tokenMint: PublicKey,
  ): Promise<{ quoteMint: PublicKey; quoteAmount: number; quoteDecimals: number } | null> {
    try {
      // Get all token accounts owned by this pool address
      const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
        poolAddress,
        { programId: TOKEN_PROGRAM_ID },
        'confirmed',
      );

      // Look for accounts that are not the token mint (these are potential quote tokens)
      for (const account of tokenAccounts.value) {
        const parsedData = account.account.data.parsed;
        if (!parsedData || !parsedData.info) continue;

        const mintAddress = new PublicKey(parsedData.info.mint);
        if (mintAddress.equals(tokenMint)) continue; // Skip the token itself

        const tokenAmount = parsedData.info.tokenAmount;
        if (!tokenAmount || !tokenAmount.uiAmount) continue;

        // Check if this is a common quote token
        const isCommonQuote = Object.values(COMMON_MINTS).some((mint) => mint.equals(mintAddress));

        if (isCommonQuote && tokenAmount.uiAmount > 0) {
          return {
            quoteMint: mintAddress,
            quoteAmount: tokenAmount.uiAmount,
            quoteDecimals: tokenAmount.decimals,
          };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Calculate price impact for different trade sizes
   */
  private calculatePriceImpact(tokenReserves: number, quoteReserves: number) {
    // Simple constant product formula approximation
    const k = tokenReserves * quoteReserves;

    const calculateImpact = (tradeSizeInQuote: number): number => {
      if (tradeSizeInQuote >= quoteReserves) return 100; // 100% impact

      const newQuoteReserves = quoteReserves + tradeSizeInQuote;
      const newTokenReserves = k / newQuoteReserves;
      const tokensOut = tokenReserves - newTokenReserves;

      const effectivePrice = tradeSizeInQuote / tokensOut;
      const currentPrice = quoteReserves / tokenReserves;

      return Math.max(0, (effectivePrice / currentPrice - 1) * 100);
    };

    return {
      for1Sol: calculateImpact(1),
      for5Sol: calculateImpact(5),
      for10Sol: calculateImpact(10),
    };
  }

  /**
   * Calculate pool health score (0-100)
   */
  private calculatePoolHealthScore(
    tokenReserves: number,
    quoteReserves: number,
    poolLamports: number,
  ): number {
    let score = 100;

    // Penalize low liquidity
    const totalValue = quoteReserves * 2; // Approximate total value
    if (totalValue < 1) score -= 30;
    else if (totalValue < 5) score -= 20;
    else if (totalValue < 20) score -= 10;

    // Penalize unbalanced pools
    const balance = Math.min(tokenReserves, quoteReserves) / Math.max(tokenReserves, quoteReserves);
    if (balance < 0.1) score -= 40;
    else if (balance < 0.3) score -= 20;
    else if (balance < 0.5) score -= 10;

    // Factor in pool account SOL balance (rent + operational balance)
    const solBalance = poolLamports / 1e9;
    if (solBalance < 0.001) score -= 20;
    else if (solBalance < 0.01) score -= 10;

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Analyze risks across all found pools
   */
  private analyzePoolRisks(pools: OnChainLpData[], totalLiquidity: number) {
    const factors: string[] = [];
    const recommendations: string[] = [];
    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME' = 'LOW';

    // Low liquidity risk
    if (totalLiquidity < 1) {
      factors.push('Very low total liquidity');
      recommendations.push('Consider skipping - insufficient liquidity');
      riskLevel = 'EXTREME';
    } else if (totalLiquidity < 5) {
      factors.push('Low total liquidity');
      recommendations.push('Use small trade sizes only');
      if (riskLevel === 'LOW') riskLevel = 'HIGH';
    } else if (totalLiquidity < 20) {
      factors.push('Moderate liquidity');
      recommendations.push('Monitor price impact carefully');
      if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
    }

    // Single pool concentration risk
    if (pools.length === 1) {
      factors.push('Single pool dependency');
      recommendations.push('Higher risk due to no redundancy');
      if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
    } else if (pools.length === 0) {
      factors.push('No pools found');
      recommendations.push('Skip - no liquidity available');
      riskLevel = 'EXTREME';
    }

    // Health score analysis
    const avgHealthScore = pools.reduce((sum, pool) => sum + pool.healthScore, 0) / pools.length;
    if (avgHealthScore < 30) {
      factors.push('Poor average pool health');
      recommendations.push('High risk pools detected');
      if (riskLevel !== 'EXTREME') riskLevel = 'HIGH';
    } else if (avgHealthScore < 60) {
      factors.push('Below average pool health');
      if (riskLevel === 'LOW') riskLevel = 'MEDIUM';
    }

    return { level: riskLevel, factors, recommendations };
  }

  /**
   * Clean expired cache entries
   */
  private cleanCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL_MS) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('LP_RESERVES', 'Cache cleanup completed', { entriesRemoved: cleaned });
    }
  }
}

// Export singleton instance
export const onChainLpAnalyzer = new OnChainLpReservesAnalyzer();

/**
 * High-level function to get on-chain LP data for a token
 */
export async function getOnChainLpReserves(
  tokenMint: string | PublicKey,
): Promise<LpPoolSearchResult> {
  const mint = typeof tokenMint === 'string' ? new PublicKey(tokenMint) : tokenMint;
  return await onChainLpAnalyzer.findLpPools(mint);
}

/**
 * Get simplified liquidity data for safety checks
 */
export async function getSimplifiedLiquidity(tokenMint: string | PublicKey): Promise<{
  totalSolLiquidity: number;
  poolCount: number;
  riskLevel: string;
  hasLiquidity: boolean;
}> {
  const result = await getOnChainLpReserves(tokenMint);

  return {
    totalSolLiquidity: result.aggregatedDepth.totalSol,
    poolCount: result.pools.length,
    riskLevel: result.riskAnalysis.level,
    hasLiquidity: result.found && result.totalLiquidity > 0,
  };
}

export default onChainLpAnalyzer;
