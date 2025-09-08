// src/utils/pumpPortalSocket.ts

import WebSocket from 'ws';
import { Buffer } from 'buffer';
import { createHash } from 'crypto';
import { pendingTokens } from '../state/pendingTokens.js';
import { PumpToken } from '../types/PumpToken.js';
import { normalizeMint } from './normalizeMint.js';
import { recordLaunch } from '../state/deployerHistory.js';

const SOCKET_URL = 'wss://pumpportal.fun/api/data';
const SEEN_TTL_MS = 10 * 60 * 1000;
const DEDUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for dedup cache
const MAX_BACKOFF_MS = 60 * 1000; // 60 seconds max backoff
const BASE_BACKOFF_MS = 1000; // 1 second base backoff

let socket: WebSocket | null = null;
let isConnected = false;
let reconnectAttempts = 0;
let lastSeenLaunchedAt = 0;
const seenMints: Record<string, number> = {};
const dedupCache = new Map<string, number>(); // content hash -> timestamp

// Helper functions
function calculateBackoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts), MAX_BACKOFF_MS);
}

function createContentHash(mint: string, creator: string, launchedAt: number): string {
  return createHash('md5').update(`${mint}|${creator}|${launchedAt}`).digest('hex');
}

function isDuplicate(contentHash: string): boolean {
  const now = Date.now();
  const timestamp = dedupCache.get(contentHash);

  if (timestamp && now - timestamp < DEDUP_CACHE_TTL_MS) {
    return true;
  }

  dedupCache.set(contentHash, now);
  return false;
}

function cleanupDedupCache(): void {
  const now = Date.now();
  for (const [hash, timestamp] of dedupCache.entries()) {
    if (now - timestamp > DEDUP_CACHE_TTL_MS) {
      dedupCache.delete(hash);
    }
  }
}

function shouldFilterToken(data: any): string | null {
  // Early filter for disqualifying flags

  // Skip non-create transactions
  if (data.txType !== 'create') return 'not-create-tx';

  // Skip tokens with 0 or odd decimals
  const decimals = data.decimals ?? 0;
  if (decimals === 0 || decimals > 9) return 'invalid-decimals';

  // Skip if missing critical fields
  if (!data.mint || !data.traderPublicKey) return 'missing-fields';

  // Skip token-2022 with transfer fees (if we can detect them)
  // This would require additional on-chain checks, placeholder for now

  return null; // Token passes early filtering
}

export async function monitorPumpPortal(onNewToken: (token: PumpToken) => void): Promise<void> {
  return connectWithBackoff(onNewToken);
}

async function connectWithBackoff(onNewToken: (token: PumpToken) => void): Promise<void> {
  if (socket) {
    socket.removeAllListeners();
    socket.close();
  }

  socket = new WebSocket(SOCKET_URL);

  socket.on('open', () => {
    const backoffMs = reconnectAttempts > 0 ? calculateBackoffMs(reconnectAttempts - 1) : 0;
    console.log(
      `✅ Connected to PumpPortal WebSocket${backoffMs > 0 ? ` (after ${backoffMs}ms backoff)` : ''}`,
    );

    isConnected = true;
    reconnectAttempts = 0; // Reset on successful connection

    // Subscribe to new tokens, optionally with resume point
    const subscribeMsg: any = { method: 'subscribeNewToken' };
    if (lastSeenLaunchedAt > 0) {
      subscribeMsg.resumeFrom = lastSeenLaunchedAt;
      console.log(`🔄 Resuming from launchedAt: ${lastSeenLaunchedAt}`);
    }

    socket?.send(JSON.stringify(subscribeMsg));
  });

  socket.on('message', async (raw) => {
    // Safely convert WebSocket.Data to string
    let text: string;
    if (typeof raw === 'string') {
      text = raw;
    } else if (raw instanceof Buffer) {
      text = raw.toString('utf-8');
    } else if (Array.isArray(raw)) {
      text = Buffer.concat(raw).toString('utf-8');
    } else if (raw instanceof ArrayBuffer) {
      text = Buffer.from(raw).toString('utf-8');
    } else if (ArrayBuffer.isView(raw)) {
      text = Buffer.from(raw.buffer).toString('utf-8');
    } else {
      console.error('Unrecognized WebSocket data type');
      return;
    }

    const data = JSON.parse(text);

    // Early filtering for disqualifying flags
    const filterReason = shouldFilterToken(data);
    if (filterReason) {
      // Optionally log filtered tokens in debug mode
      // console.debug(`Filtered token ${data.mint}: ${filterReason}`);
      return;
    }

    // Content-based deduplication
    const launchedAt = data.launchedAt ?? Date.now();
    const contentHash = createContentHash(data.mint, data.traderPublicKey, launchedAt);

    if (isDuplicate(contentHash)) {
      console.debug(`Ignoring duplicate token: ${data.mint}`);
      return;
    }

    // Update resume point
    if (launchedAt > lastSeenLaunchedAt) {
      lastSeenLaunchedAt = launchedAt;
    }

    const pool = data.pool; // "bonk" or "pump" or other
    const rawMint = data.mint;

    // Decide whether to normalize or use raw mint
    let mint: string;
    if (pool === 'pump' || pool === 'bonk') {
      // Curve pools: use raw mint directly
      mint = rawMint;
    } else {
      // Non-curve: validate Base58 public key
      const normalized = normalizeMint(rawMint, pool);
      if (!normalized) {
        console.warn(`⚠️ Could not normalize mint for ${rawMint}`);
        return;
      }
      mint = normalized;
    }

    const discoveredAt = Date.now();

    const token: PumpToken = {
      mint,
      pool,
      signature: data.signature,
      creator: data.traderPublicKey,
      launchedAt: data.launchedAt ?? discoveredAt,
      discoveredAt,
      simulatedLp:
        pool === 'bonk' ? data.solInPool : (data.vSolInBondingCurve ?? 0) + (data.solAmount ?? 0),
      earlyHolders: pool === 'pump' ? (data.vTokensInBondingCurve ?? 0) : 0,
      hasJupiterRoute: false,
      lpTokenAddress: pool,
      metadata: {
        name: data.name,
        symbol: data.symbol,
        decimals: data.decimals ?? 0,
      },
      launchSpeedSeconds: data.launchSpeedSeconds ?? 0,
    };

    // Enqueue and notify
    pendingTokens.set(mint, token);
    recordLaunch(token.creator);
    onNewToken(token);
  });

  socket.on('close', (code, reason) => {
    isConnected = false;
    reconnectAttempts++;
    const backoffMs = calculateBackoffMs(reconnectAttempts - 1);

    console.warn(
      `🔌 PumpPortal socket closed (code: ${code}, reason: ${reason}). Reconnecting in ${backoffMs}ms... (attempt ${reconnectAttempts})`,
    );

    setTimeout(() => connectWithBackoff(onNewToken), backoffMs);
  });

  socket.on('error', (err) => {
    console.error('❌ PumpPortal WebSocket error:', err.message);
    isConnected = false;
  });

  // Clean up old entries
  setInterval(() => {
    const now = Date.now();

    // Clean up seenMints
    for (const m of Object.keys(seenMints)) {
      if (now - seenMints[m] > SEEN_TTL_MS) {
        delete seenMints[m];
      }
    }

    // Clean up dedup cache
    cleanupDedupCache();
  }, 60_000);
}
