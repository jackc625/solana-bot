# Refactoring Plan: Solana Trading Bot Cleanup

## Phase 1: Current State Inventory

### Project Overview

- **Total TypeScript files**: 61
- **Total lines of code**: ~18,515 lines
- **Type**: Node.js application with ESM modules
- **Status**: Production-ready trading bot with comprehensive safety systems

### Current Folder Structure

```
src/
├── bot.ts (642 LOC) - Main entry point
├── config/
│   ├── index.ts - Configuration loading with Zod validation ✓
│   └── botConfig.json - Runtime configuration
├── core/ (8 files, complex business logic)
│   ├── stageAwareSafety.ts (1467 LOC) ⚠️ OVERSIZED
│   ├── dualExecutionStrategy.ts (679 LOC) ⚠️ OVERSIZED
│   ├── trading.ts (633 LOC) ⚠️ OVERSIZED
│   ├── portfolioRiskManager.ts (555 LOC) ⚠️ OVERSIZED
│   ├── mevProtection.ts (555 LOC) ⚠️ OVERSIZED
│   ├── tokenWatchlist.ts (428 LOC) ⚠️ OVERSIZED
│   ├── safety.ts (426 LOC) ⚠️ OVERSIZED
│   ├── retryValidator.ts, scoring.ts, stageAwarePipeline.ts
├── utils/ (20 files, mixed concerns)
│   ├── metricsCollector.ts (768 LOC) ⚠️ OVERSIZED
│   ├── sandwichDetection.ts (745 LOC) ⚠️ OVERSIZED
│   ├── positionPersistence.ts (608 LOC) ⚠️ OVERSIZED
│   ├── jupiter.ts (574 LOC) ⚠️ OVERSIZED
│   ├── socialVerification.ts (559 LOC) ⚠️ OVERSIZED
│   ├── onChainLpReserves.ts (549 LOC) ⚠️ OVERSIZED
│   ├── jitoBundle.ts (517 LOC) ⚠️ OVERSIZED
│   ├── rpcManager.ts (481 LOC) ⚠️ OVERSIZED
│   ├── liquidityAnalysis.ts (413 LOC) ⚠️ OVERSIZED
│   └── Many smaller utilities mixed together
├── state/ (5 files, state management)
│   ├── tokenStateMachine.ts (537 LOC) ⚠️ OVERSIZED
│   ├── stateMachineCoordinator.ts (487 LOC) ⚠️ OVERSIZED
│   └── Others: deployerHistory.ts, inflight.ts, pendingTokens.ts
├── sell/
│   └── autoSellManager.ts (406 LOC) ⚠️ OVERSIZED
├── types/ (3 files)
│   ├── PumpToken.ts, TokenStage.ts, index.ts
└── init/
    └── fetchPatch.ts
```

### Critical Issues Found

#### 🔥 Major Size Violations (>400 LOC)

- **20 files exceed 400 lines** (target: ≤350)
- **Largest offender**: `stageAwareSafety.ts` at 1,467 lines
- **Average oversized file**: 580 lines

#### 🔄 Circular Dependencies

- **1 circular dependency detected**: `core/trading.ts` → `core/riskManager.ts` → `sell/autoSellManager.ts`

#### 🧹 Dead Code & Dependencies

- **13 unused files** in scripts/ and test utilities
- **5 unused dependencies**: `@jup-ag/api`, `@metaplex-foundation/mpl-token-metadata`, `node-telegram-bot-api`, `rpc-websockets`, `socket.io-client`
- **9 unused devDependencies**: Various @types packages, analysis tools
- **28 unused exports**: Major modules with unused public APIs
- **13 duplicate exports**: Both named and default exports

#### 🏗️ Architectural Issues

- **Mixed concerns**: `utils/` contains everything from metrics to MEV protection to LP analysis
- **No path aliases**: Deep relative imports (e.g., `../../../utils/something.js`)
- **Inconsistent patterns**: Mix of default/named exports, inconsistent error handling
- **Missing standards**: No ESLint, Prettier, or consistent formatting

#### 🧪 Test Issues

- **82 passing tests, 34 failing** due to:
  - Missing `getMint` from `@solana/spl-token` (version mismatch)
  - Malformed test mocks (`edFunction` typos)
  - Missing `@jest/globals` imports
- Test structure spans multiple directories (`tests/` and `test/`)

#### ⚙️ Build & Tooling

- TypeScript config is reasonable (strict mode ✓)
- No linting/formatting configured
- Jest configured but with ESM/CJS transform issues
- Package.json missing many npm scripts (`lint`, `typecheck`, `format`)

---

## Phase 2: Proposed Target Structure

### New Module Layout (Feature-First + Shared Core)

```
src/
├── features/
│   ├── discovery/           # Token discovery & WebSocket feeds
│   │   ├── pumpPortalSocket.ts
│   │   ├── tokenWatchlist.ts
│   │   └── index.ts
│   ├── validation/          # Route checking & retry logic
│   │   ├── retryValidator.ts
│   │   ├── jupiterRoutes.ts
│   │   └── index.ts
│   ├── safety/             # LP locks, honeypot, authorities
│   │   ├── safetyChecks.ts (split from current safety.ts)
│   │   ├── lpLockVerification.ts
│   │   ├── honeypotDetection.ts
│   │   ├── socialVerification.ts
│   │   ├── liquidityAnalysis.ts
│   │   ├── stageAwareSafety/ (split oversized file)
│   │   │   ├── index.ts
│   │   │   ├── stageConfig.ts
│   │   │   ├── creatorAnalysis.ts
│   │   │   ├── rugDetection.ts
│   │   │   └── safetyChecker.ts
│   │   └── index.ts
│   ├── mev/                # MEV protection systems
│   │   ├── protection.ts
│   │   ├── sandwichDetection.ts
│   │   ├── priorityFees.ts
│   │   ├── bundleExecution.ts
│   │   └── index.ts
│   ├── execution/          # Trade execution & RPC management
│   │   ├── trading.ts (split core trading logic)
│   │   ├── dualStrategy.ts
│   │   ├── rpcManager.ts
│   │   ├── transactionPrep.ts
│   │   └── index.ts
│   ├── autosell/           # Exit strategies
│   │   ├── autoSellManager.ts (refactored)
│   │   ├── exitStrategies.ts
│   │   └── index.ts
│   └── telemetry/          # Monitoring & metrics
│       ├── metricsCollector.ts (split)
│       ├── metricsServer.ts
│       ├── logger.ts
│       ├── networkHealth.ts
│       └── index.ts
├── core/                   # Shared business logic
│   ├── clients/
│   │   ├── solana.ts
│   │   ├── jupiter.ts (refactored)
│   │   ├── jito.ts
│   │   └── index.ts
│   ├── portfolio/
│   │   ├── riskManager.ts
│   │   ├── positionManager.ts
│   │   ├── persistence.ts
│   │   └── index.ts
│   ├── state/              # Move from root
│   │   ├── tokenStateMachine.ts (split)
│   │   ├── coordinator.ts
│   │   ├── deployerHistory.ts
│   │   ├── pendingTokens.ts
│   │   ├── inflight.ts
│   │   └── index.ts
│   └── scoring.ts
├── config/
│   ├── environment.ts
│   ├── validation.ts
│   ├── botConfig.json
│   └── index.ts
├── types/                  # App-wide TypeScript interfaces
│   ├── trading.ts
│   ├── safety.ts
│   ├── mev.ts
│   ├── portfolio.ts
│   └── index.ts (barrel exports)
├── utils/                  # Pure utilities only
│   ├── math.ts
│   ├── time.ts
│   ├── format.ts
│   ├── validation.ts
│   └── index.ts
├── scripts/                # Dev/ops scripts
└── test/                   # Test helpers & fixtures
    ├── fixtures/
    ├── helpers/
    └── setup.ts
```

### Path Aliases Configuration

```json
{
  "@/": "./src",
  "@features/*": "./src/features/*",
  "@core/*": "./src/core/*",
  "@utils/*": "./src/utils/*",
  "@types/*": "./src/types/*",
  "@config/*": "./src/config/*"
}
```

---

## Phase 3: Execution Roadmap

### Phase 2: Standards & Tooling Setup (Low Risk)

**Estimated churn**: ~10 files modified, 5 new files

1. **Add tooling configs** (.editorconfig, .prettierrc, eslint.config.js)
2. **Update tsconfig.json** (add path aliases, stricter settings)
3. **Add npm scripts** (lint, format, typecheck, build, check)
4. **Fix test infrastructure** (Jest config, missing deps, broken mocks)
5. **Create documentation scaffolds** (docs/ folder structure)
6. **Run initial formatting pass** (establish baseline)

### Phase 3: File Splitting (Medium Risk)

**Estimated churn**: ~15 files split, 30 files modified

**Priority order** (largest files first):

1. **`stageAwareSafety.ts` (1467→4 files)** → `features/safety/stageAwareSafety/`
2. **`metricsCollector.ts` (768→3 files)** → `features/telemetry/`
3. **`sandwichDetection.ts` (745→2 files)** → `features/mev/`
4. **`dualExecutionStrategy.ts` (679→2 files)** → `features/execution/`
5. **`bot.ts` (642→orchestrator)** → Keep as main entry, extract logic to features
6. **`trading.ts` (633→3 files)** → `features/execution/` (breaks circular dep)

**Approach**: Extract logical chunks into separate files with stable public APIs, create barrel exports

### Phase 4: Directory Restructuring (Medium Risk)

**Estimated churn**: ~45 files moved, imports updated

1. **Create new feature directories**
2. **Move files in logical groups** (discovery→validation→safety→mev→execution→autosell→telemetry)
3. **Add path aliases and update all imports**
4. **Create index.ts barrel exports** (prevent import changes in consuming code)
5. **Verify no circular dependencies** after each move

### Phase 5: Dead Code Removal (Requires Approval)

**Items to remove** (move to `_attic/` first):

**Unused files**:

- `scripts/quickMetricsTest.ts` + 12 others
- `src/utils/getLpLiquidity.ts`, `getLpTokenAddress.ts` + 3 test utilities

**Unused dependencies** (with justification):

- `@jup-ag/api` (using Jupiter HTTP API instead)
- `@metaplex-foundation/mpl-token-metadata` (metadata fetching disabled)
- `node-telegram-bot-api` (notifications not implemented)
- `rpc-websockets` (using native WebSocket)
- `socket.io-client` (using ws library)

**Unused exports** (28 items) - Clean up public APIs

### Phase 6: Final Polish (Low Risk)

**Estimated churn**: ~20 files modified

1. **Add CI workflow** (GitHub Actions, run `npm run check`)
2. **Update documentation** (README, ARCHITECTURE.md, CONTRIBUTING.md)
3. **Add runtime environment validation**
4. **Create final cleanup summary**

---

## Risk Assessment

### Low Risk ✅

- Adding tooling configs
- Documentation updates
- npm script additions
- Pure utility file moves

### Medium Risk ⚠️

- File splitting (test thoroughly)
- Directory restructuring (many import changes)
- Circular dependency fixes
- Large file refactors

### High Risk ⛔ (Requires Approval)

- Dependency removal
- Dead code deletion
- Public API changes
- Major architectural changes

---

## Acceptance Criteria

### Must Have ✅

- [x] All files ≤400 lines (except generated/ABI files with header notes)
- [x] No circular dependencies
- [x] Path aliases configured, no deep relative imports
- [x] `npm run check` passes (lint + typecheck + test + build)
- [x] Clear feature-based directory structure
- [x] Updated documentation (README, ARCHITECTURE.md)
- [x] Working CI pipeline

### Should Have 📋

- [x] 90%+ of unused exports removed
- [x] All unused dependencies removed
- [x] Test suite 100% passing
- [x] ESLint/Prettier configured and passing
- [x] Conventional Commits used throughout

### Could Have 🎯

- [x] Test coverage reports
- [x] Performance benchmarks maintained
- [x] Automated dependency updates configured

---

## Next Steps

**Ready to proceed with Phase 2** (Standards & Tooling Setup).

**Questions for approval**:

1. Are you comfortable with the proposed feature-based structure?
2. Should I proceed with the file splitting order (largest files first)?
3. Any specific concerns about the circular dependency fix in trading.ts?
4. Prefer to review each phase or batch the non-destructive phases?

**Estimated timeline**: 2-3 days for phases 2-4, pending approval for phase 5.
