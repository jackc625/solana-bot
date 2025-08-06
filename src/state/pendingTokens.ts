// src/state/pendingTokens.ts

import { PumpToken } from "../types/PumpToken.js";

/**
 * Global map of mint → PumpToken for tokens pending full validation.
 * Used by monitorPumpSocket and the background safety-check validator.
 */
export const pendingTokens = new Map<string, PumpToken>();
