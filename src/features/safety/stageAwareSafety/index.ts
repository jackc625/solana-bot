// Safety façade - stable API for stage-aware safety evaluation
import type { PumpToken } from '../../../types/PumpToken.js';
import type { TokenCandidate, SafetyCheckConfig } from '../../../types/TokenStage.js';
import { Connection } from '@solana/web3.js';
import { StageAwareSafetyChecker } from '../../../core/stageAwareSafety.js';

export interface SafetyContext {
  connection: Connection;
  config?: SafetyCheckConfig;
  [key: string]: any;
}

export interface SafetyReport {
  passed: boolean;
  stage: string;
  riskScore: number;
  failures: string[];
  warnings: string[];
  metadata: {
    checksRun: string[];
    executionTimeMs: number;
    stage: string;
  };
}

// Stable façade for safety evaluation
export async function evaluateToken(input: PumpToken, ctx: SafetyContext): Promise<SafetyReport> {
  // Temporarily delegate to the existing large module
  // TODO: Replace with extracted check functions as they're moved
  const checker = new StageAwareSafetyChecker();
  
  try {
    const candidate: TokenCandidate = {
      mint: input.mint,
      name: input.name || '',
      symbol: input.symbol || '',
      stage: 'DISCOVERY',
      lastStageTransition: Date.now(),
      riskScore: 0,
      metadata: input,
    };
    
    const result = await checker.checkTokenSafety(candidate, ctx.connection, ctx.config);
    
    return {
      passed: result.passed,
      stage: result.stage || 'UNKNOWN',
      riskScore: result.riskScore || 0,
      failures: result.failures || [],
      warnings: result.warnings || [],
      metadata: {
        checksRun: result.metadata?.checksRun || [],
        executionTimeMs: result.metadata?.executionTimeMs || 0,
        stage: result.stage || 'UNKNOWN',
      },
    };
  } catch (error) {
    return {
      passed: false,
      stage: 'ERROR',
      riskScore: 100,
      failures: [`Safety evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
      warnings: [],
      metadata: {
        checksRun: [],
        executionTimeMs: 0,
        stage: 'ERROR',
      },
    };
  }
}