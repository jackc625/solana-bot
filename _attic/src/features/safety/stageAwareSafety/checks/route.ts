// Jupiter route validation check - extracted from stageAwareSafety.ts
import logger from '../../../../utils/logger.js';
import metricsCollector from '../../../../utils/metricsCollector.js';
import { hasDirectJupiterRouteHttp } from '../../../../utils/jupiterHttp.js';
import { getCurrentPriceViaJupiter } from '../../../../core/trading.js';

export interface RouteCheckResult {
  hasRoute: boolean;
  liquidity?: number;
  priceImpact?: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  failures: string[];
}

export interface LiquidityConfig {
  minLiquidity: number;
  maxLiquidity?: number;
}

/**
 * Check Jupiter route availability and liquidity depth
 * Extracted from StageAwareSafetyChecker RAYDIUM_LISTED stage checks
 */
export async function checkJupiterRoute(
  mint: string,
  config: LiquidityConfig,
  walletPubkey?: any,
): Promise<RouteCheckResult> {
  const failures: string[] = [];
  let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';

  try {
    // 1) Jupiter route validation
    logger.debug('STAGE_SAFETY', 'Checking Jupiter route', {
      mint: mint.substring(0, 8) + '...',
    });

    const hasRoute = await hasDirectJupiterRouteHttp(
      'So11111111111111111111111111111111111111112', // SOL
      mint,
    );

    if (!hasRoute) {
      failures.push('NO_ROUTE');
      metricsCollector.recordSafetyCheck('liquidity', 'fail');
      return {
        hasRoute: false,
        riskLevel: 'HIGH',
        failures,
      };
    }

    metricsCollector.recordSafetyCheck('liquidity', 'pass');

    // 2) Liquidity depth check
    if (walletPubkey) {
      logger.debug('STAGE_SAFETY', 'Checking liquidity depth', {
        mint: mint.substring(0, 8) + '...',
      });

      const wallet = { publicKey: walletPubkey } as any; // Mock wallet for price check
      const priceInfo = await getCurrentPriceViaJupiter(mint, 0.005, wallet);

      if (!priceInfo || !priceInfo.liquidity) {
        failures.push('LOW_LIQUIDITY');
        metricsCollector.recordSafetyCheck('liquidity', 'fail');
        riskLevel = 'HIGH';
      } else {
        const liquidity = priceInfo.liquidity;
        const priceImpact = priceInfo.priceImpact;

        if (liquidity < config.minLiquidity) {
          failures.push('LOW_LIQUIDITY');
          metricsCollector.recordSafetyCheck('liquidity', 'fail');
          riskLevel = 'HIGH';
        } else if (config.maxLiquidity && liquidity > config.maxLiquidity) {
          failures.push('HIGH_LIQUIDITY');
          metricsCollector.recordSafetyCheck('liquidity', 'fail');
          riskLevel = 'MEDIUM';
        } else {
          metricsCollector.recordSafetyCheck('liquidity', 'pass');
        }

        return {
          hasRoute: true,
          liquidity,
          priceImpact,
          riskLevel,
          failures,
        };
      }
    }

    return {
      hasRoute: true,
      riskLevel,
      failures,
    };
  } catch (error) {
    logger.debug('STAGE_SAFETY', 'Route check failed', {
      mint: mint.substring(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      hasRoute: false,
      riskLevel: 'HIGH',
      failures: ['ROUTE_CHECK_FAILED'],
    };
  }
}