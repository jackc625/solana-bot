// src/features/discovery/pendingTokens.ts
// Moved from src/state/pendingTokens.ts

import { PumpToken } from '../../types/PumpToken.js';

/**
 * Global map of mint → PumpToken for tokens pending full validation.
 * Used by monitorPumpSocket and the background safety-check validator.
 */
export const pendingTokens = new Map<string, PumpToken>();

// Functional API for encapsulation
export function addPendingToken(mint: string, token: PumpToken): void {
  pendingTokens.set(mint, token);
}

export function getPendingTokens(): Map<string, PumpToken> {
  return pendingTokens;
}

export function removePendingToken(mint: string): boolean {
  return pendingTokens.delete(mint);
}

export function clearPendingTokens(): void {
  pendingTokens.clear();
}

export function hasPendingToken(mint: string): boolean {
  return pendingTokens.has(mint);
}
