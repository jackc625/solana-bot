// Compatibility wrapper for @solana/spl-token API changes
// This addresses version compatibility issues with getMint and other functions

import * as splToken from '@solana/spl-token';
import type { Connection, PublicKey } from '@solana/web3.js';

// Type re-exports for compatibility
export type { Mint, Account } from '@solana/spl-token';

// Check if getMint is available in the current version
export const getMintCompat = (splToken as any).getMint || (splToken as any).getMint;

// Wrapper function with fallback
export async function getMint(
  connection: Connection,
  address: PublicKey,
  commitment?: any,
  programId?: PublicKey,
): Promise<any> {
  if (getMintCompat) {
    return getMintCompat(connection, address, commitment, programId);
  }

  // Fallback implementation if needed
  throw new Error('getMint not available in current @solana/spl-token version');
}

// Re-export other commonly used functions
export const {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} = splToken;
