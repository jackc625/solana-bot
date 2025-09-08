// Token authorities safety check - extracted from stageAwareSafety.ts
import { Connection, PublicKey } from '@solana/web3.js';
import logger from '../../../../utils/logger.js';

export interface AuthoritiesCheckResult {
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
  mintAuthority?: string;
  freezeAuthority?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
}

/**
 * Check token mint and freeze authorities for risks
 * Extracted from StageAwareSafetyChecker.checkTokenAuthorities
 */
export async function checkTokenAuthorities(
  mint: string,
  connection: Connection,
): Promise<AuthoritiesCheckResult> {
  try {
    const mintPubkey = new PublicKey(mint);
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);

    if (!mintInfo.value?.data || typeof mintInfo.value.data === 'string') {
      return {
        hasMintAuthority: true, // Assume worst case
        hasFreezeAuthority: true,
        riskLevel: 'HIGH',
      };
    }

    const parsedInfo = (mintInfo.value.data as any).parsed?.info;
    if (!parsedInfo) {
      return {
        hasMintAuthority: true,
        hasFreezeAuthority: true,
        riskLevel: 'HIGH',
      };
    }

    const hasMintAuthority = parsedInfo.mintAuthority !== null;
    const hasFreezeAuthority = parsedInfo.freezeAuthority !== null;

    let riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'LOW';
    if (hasMintAuthority && hasFreezeAuthority) riskLevel = 'HIGH';
    else if (hasMintAuthority || hasFreezeAuthority) riskLevel = 'MEDIUM';

    return {
      hasMintAuthority,
      hasFreezeAuthority,
      mintAuthority: parsedInfo.mintAuthority,
      freezeAuthority: parsedInfo.freezeAuthority,
      riskLevel,
    };
  } catch (error) {
    logger.debug('STAGE_SAFETY', 'Failed to check token authorities', {
      mint: mint.substring(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      hasMintAuthority: true, // Conservative assumption
      hasFreezeAuthority: true,
      riskLevel: 'HIGH',
    };
  }
}