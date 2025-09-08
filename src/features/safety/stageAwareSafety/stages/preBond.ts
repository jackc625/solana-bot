// PreBond stage validation - extracted from stageAwareSafety.ts
import type { TokenCandidate, StageTransitionResult, FailureReason } from '../../../../types/TokenStage.js';
import logger from '../../../../utils/logger.js';

export interface PreBondConfig {
  enabled: boolean;
  minNameLength: number;
  maxNameLength: number;
  requireSocialPresence: boolean;
}

export interface TokenMetadata {
  name?: string;
  symbol?: string;
  description?: string;
  socialLinks?: any;
  [key: string]: any;
}

/**
 * PRE_BOND stage checks - only run fast, off-chain-ish validations
 * No Jupiter routes, LP depth, or on-chain state checks
 * Extracted from StageAwareSafetyChecker.checkPreBond
 */
export async function checkPreBondStage(
  candidate: TokenCandidate,
  config: PreBondConfig,
  getTokenMetadataEnhanced: (mint: string) => Promise<TokenMetadata>,
  hasScamIndicators: (metadata: TokenMetadata) => boolean,
  verifySocialLinks: (links: any) => Promise<number>,
): Promise<StageTransitionResult> {
  const reasons: FailureReason[] = [];

  try {
    if (!config.enabled) {
      return { success: true, newStage: 'BONDED_ON_PUMP' };
    }

    // 1) Enhanced token metadata analysis with social verification
    const metadata = await getTokenMetadataEnhanced(candidate.mint);
    if (metadata.name) {
      if (metadata.name.length < config.minNameLength || metadata.name.length > config.maxNameLength) {
        reasons.push('INVALID_NAME');
      }

      // Check for scam indicators in name/description
      if (hasScamIndicators(metadata)) {
        reasons.push('INVALID_NAME');
      }

      // Social media verification
      if (metadata.socialLinks) {
        const socialScore = await verifySocialLinks(metadata.socialLinks);
        if (socialScore < 2 && config.requireSocialPresence) {
          reasons.push('LOW_SOCIAL_SCORE');
        }
      }
    } else {
      // No metadata found
      if (config.requireSocialPresence) {
        reasons.push('LOW_SOCIAL_SCORE');
      }
    }

    // 2) Basic symbol validation
    if (metadata.symbol) {
      if (metadata.symbol.length < 1 || metadata.symbol.length > 10) {
        reasons.push('INVALID_SYMBOL');
      }
    }

    logger.debug('STAGE_SAFETY', 'Pre-bond stage check completed', {
      mint: candidate.mint.substring(0, 8) + '...',
      passed: reasons.length === 0,
      failures: reasons.length,
    });

    if (reasons.length > 0) {
      return {
        success: false,
        reasons,
        newStage: candidate.stage, // Stay in current stage
      };
    }

    return {
      success: true,
      newStage: 'BONDED_ON_PUMP',
    };
  } catch (error) {
    logger.error('STAGE_SAFETY', 'Pre-bond stage check failed', {
      mint: candidate.mint.substring(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      reasons: ['CHECK_FAILED'],
      newStage: candidate.stage,
    };
  }
}