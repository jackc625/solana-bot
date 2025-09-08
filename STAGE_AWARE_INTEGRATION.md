# Stage-Aware Pipeline Integration Guide

## Problem Fixed

The bot was running post-bond safety checks (Jupiter routes, LP depth, honeypot simulation) on pre-bond tokens that don't have Raydium pools yet, causing 100% rejection rate.

## Solution Architecture

### 3-Stage Token Processing

1. **PRE_BOND** - Fast off-chain checks only:
   - Token name/symbol validation
   - Creator wallet history & age
   - Time window (skip dead hours)
   - Pre-bond scoring

2. **BONDED_ON_PUMP** - Pool detection with backoff:
   - Wait for Raydium pool creation (up to 5 minutes)
   - Exponential backoff: [2s, 3s, 5s, 8s, 13s]
   - Track early velocity (optional)

3. **RAYDIUM_LISTED** - Full safety validation:
   - Jupiter route validation
   - Liquidity depth analysis  
   - Honeypot simulation
   - LP lock verification
   - Social verification
   - All existing safety checks

## Quick Integration

### 1. Add to bot.ts imports:
```typescript
import { stageAwarePipeline } from "./core/stageAwarePipeline.js";
import { stageAwareMetrics } from "./utils/stageAwareMetrics.js";
```

### 2. Initialize in main() function:
```typescript
// After RPC initialization, before monitoring
console.log("🎯 Initializing stage-aware pipeline...");
try {
    await stageAwarePipeline.start();
    console.log("✅ Stage-aware pipeline started");
} catch (error) {
    console.warn("⚠️ Stage-aware pipeline failed to start, using legacy mode", error);
}
```

### 3. Route new tokens through stage-aware pipeline:
```typescript
// In monitorPumpPortal callback, REPLACE the direct validation call:
await monitorPumpPortal((token) => {
    const norm = normalizeMint(token.mint, token.pool);
    if (!norm) return;
    
    // NEW: Route through stage-aware pipeline first
    const added = stageAwarePipeline.addDiscoveredToken({
        ...token, 
        mint: norm
    });
    
    if (added) {
        console.log("🎯 Token routed to stage-aware pipeline:", norm.substring(0, 8) + '...');
    } else {
        // Fallback to legacy pipeline
        if (!pendingTokens.has(norm)) {
            pendingTokens.set(norm, { ...token, mint: norm });
        }
    }
});
```

### 4. Modify handleValidatedToken to pull from stage-aware pipeline:
```typescript
// At the START of handleValidatedToken function:
async function handleValidatedToken(token: PumpToken) {
    const config = loadBotConfig();
    const wallet = loadWallet();
    if (!wallet) return;

    // NEW: Try to get ready token from stage-aware pipeline first
    const readyToken = await stageAwarePipeline.getReadyToken();
    if (readyToken) {
        token = readyToken; // Use the pre-validated token
        console.log(`✅ Using pre-validated token from stage-aware pipeline: ${token.mint.substring(0, 8)}...`);
        
        // Skip to sniping - safety checks already passed
        const buyAmount = config.buyAmounts[String(6)] ?? 0.005; // Use high score since it passed validation
        console.log(`🚀 Stage-aware token ready; sniping ${token.mint} for ${buyAmount} SOL`);
        
        await trySnipeToken(connection, wallet, token.mint, buyAmount, config.dryRun, token.creator);
        return; // Done - no need for legacy validation
    }
    
    // Continue with existing legacy validation logic for tokens not in stage-aware pipeline
    // ... rest of existing function unchanged ...
}
```

### 5. Add periodic diagnostics:
```typescript
// In main() after initialization:
setInterval(() => {
    const stats = stageAwarePipeline.getStats();
    if (stats.watchlistStats.totalTokens > 0) {
        console.log(`📊 Stage Pipeline: ${stats.watchlistStats.totalTokens} tokens, ` +
                   `${stats.watchlistStats.byStage.PRE_BOND} pre-bond, ` +
                   `${stats.watchlistStats.byStage.BONDED_ON_PUMP} bonded, ` +
                   `${stats.watchlistStats.byStage.RAYDIUM_LISTED} ready`);
    }
}, 30_000); // Every 30 seconds
```

## Configuration

Add to `botConfig.json`:
```json
{
  "stageAwarePipeline": {
    "enabled": true,
    "debugMode": false,
    "maxConcurrentTokens": 50
  }
}
```

## Expected Results

### Before (Current State):
- 100% token rejection due to pre-bond/post-bond check mismatch
- Logs showing: "No route found", "Liquidity < threshold", "Failed to simulate price"
- 0 successful snipes

### After (Stage-Aware):
- PRE_BOND: Fast filtering of obviously bad tokens (bad names, blacklisted creators, etc.)
- BONDED_ON_PUMP: Patient waiting for pool creation with exponential backoff
- RAYDIUM_LISTED: Full validation only when routes actually exist
- Expected 10-30% tokens reaching RAYDIUM_LISTED stage
- 2-5% final success rate (normal for production trading)

## Monitoring & Debugging

### View detailed diagnostics:
```javascript
// In your debugging/monitoring code:
console.log(stageAwarePipeline.generateDiagnosticsReport());
```

### Key metrics to watch:
- **Stage distribution**: How many tokens in each stage
- **Transition rates**: PRE_BOND → BONDED_ON_PUMP → RAYDIUM_LISTED
- **Top failure reasons**: What's causing the most rejections
- **Pool detection timing**: How long pools take to appear

### Failure reason breakdown:
- `invalid_name`, `creator_too_new`, `dead_hours` → PRE_BOND issues
- `no_pool_timeout` → BONDED_ON_PUMP issues (normal for 70-80% of tokens)
- `low_liquidity`, `honeypot`, `no_lp_lock` → RAYDIUM_LISTED issues

## Rollback Plan

If stage-aware pipeline causes issues:

1. Set `stageAwarePipeline.enabled = false` in config
2. Restart bot - will fall back to legacy pipeline
3. Check logs for specific errors

## Testing

### Enable debug mode:
```json
{
  "stageAwarePipeline": {
    "debugMode": true
  }
}
```

### View live pipeline state:
- Check console logs for stage transitions
- Monitor token flow: PRE_BOND → BONDED_ON_PUMP → RAYDIUM_LISTED
- Verify pool detection is working with backoff retries

## Files Created

- `src/types/TokenStage.ts` - Types and enums for stage-aware processing
- `src/core/stageAwareSafety.ts` - Stage-specific safety check implementations  
- `src/utils/poolDetection.ts` - Pool detection with exponential backoff
- `src/core/tokenWatchlist.ts` - Stage-aware token watchlist management
- `src/utils/stageAwareMetrics.ts` - Enhanced metrics for stage-aware pipeline
- `src/core/stageAwarePipeline.ts` - Integration layer and main pipeline orchestrator

This architecture fixes the core issue while maintaining full backward compatibility with the existing bot infrastructure.