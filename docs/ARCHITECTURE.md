# Architecture Overview

This document describes the current architecture of the Solana trading bot after Phase 4-5 restructuring.

## Directory Structure

```
src/
├── bot.ts                      # Main entry point
├── config/                     # Configuration management
│   └── index.ts               # Bot configuration loader
├── core/                      # Core business logic
│   ├── safety.ts             # Token safety validation
│   ├── scoring.ts            # Token scoring algorithm
│   ├── trading.ts            # Core trading operations
│   ├── riskManager.ts        # Portfolio risk management
│   ├── portfolioRiskManager.ts # Advanced risk controls
│   ├── retryValidator.ts     # Retry validation logic
│   ├── stageAwarePipeline.ts # Stage-aware token processing
│   ├── stageAwareSafety.ts   # Advanced safety pipeline
│   └── emergencyCircuitBreaker.ts # Emergency halt controls
├── features/                  # Feature-first organization
│   ├── execution/            # Trade execution features
│   │   ├── index.ts         # Barrel exports
│   │   ├── types.ts         # Execution types
│   │   ├── dualExecutionStrategy.ts # MEV-aware execution
│   │   └── transactionPreparation.ts # ATA pre-creation
│   ├── mev/                 # MEV protection features
│   │   ├── index.ts         # Barrel exports
│   │   ├── mevProtection.ts # Main MEV protection
│   │   ├── jitoBundle.ts    # Jito bundle integration
│   │   ├── mevAwarePriorityFee.ts # Dynamic fees
│   │   ├── mevAwarePumpTrade.ts # MEV-aware trading
│   │   └── sandwichDetection.ts # Sandwich attack detection
│   ├── telemetry/           # Monitoring and metrics
│   │   ├── index.ts         # Barrel exports
│   │   ├── metricsCollector.ts # Prometheus metrics
│   │   ├── metricsServer.ts # HTTP metrics server
│   │   └── stageAwareMetrics.ts # Pipeline metrics
│   ├── validation/          # Token validation
│   │   ├── index.ts         # Barrel exports
│   │   ├── retryValidator.ts # Background validator
│   │   ├── jupiterHttp.ts   # Jupiter HTTP fallback
│   │   └── onChainLpReserves.ts # On-chain LP analysis
│   ├── discovery/           # Token discovery
│   │   └── tokenWatchlist.ts # Token watchlist management
│   └── safety/              # Safety systems
│       └── stageAwareSafety/ # Advanced safety checks
├── state/                   # State management
│   ├── pendingTokens.ts     # Pending token queue
│   ├── tokenStateMachine.ts # Token state machine
│   └── stateMachineCoordinator.ts # State coordination
├── utils/                   # Shared utilities
│   ├── solana.ts           # Solana connection utilities
│   ├── rpcManager.ts       # Multi-RPC management
│   ├── logger.ts           # Structured logging
│   ├── telegram.ts         # Telegram notifications
│   ├── positionPersistence.ts # Position state persistence
│   ├── pumpPortalSocket.ts # Pump.fun WebSocket
│   ├── jupiter.ts          # Jupiter integration
│   ├── liquidityAnalysis.ts # Liquidity depth analysis
│   ├── lpLockVerification.ts # LP lock verification
│   ├── socialVerification.ts # Social media verification
│   ├── networkHealth.ts    # Network health monitoring
│   ├── priorityFee.ts      # Priority fee calculation
│   ├── pumpTrade.ts        # PumpPortal trading
│   ├── normalizeMint.ts    # Mint address normalization
│   ├── blacklist.ts        # Token blacklist
│   ├── globalCooldown.ts   # Trading cooldowns
│   ├── hasDirectJupiterRoute.ts # Route validation
│   ├── poolDetection.ts    # Pool detection
│   ├── time.ts             # Time utilities
│   ├── validateEnvironment.ts # Environment validation
│   └── withTimeout.ts      # Timeout wrapper
├── types/                  # TypeScript type definitions
│   ├── index.ts           # Main type exports
│   ├── PumpToken.ts       # Token data structure
│   └── TokenStage.ts      # Token processing stages
├── sell/                   # Auto-sell functionality
│   └── autoSellManager.ts # Position management
└── init/                  # Initialization
    └── fetchPatch.js      # Fetch API patches
```

## Import Aliases

The codebase uses path aliases for clean imports:

- `@/*` - Root src directory
- `@config/*` - Configuration files
- `@core/*` - Core business logic
- `@features/*` - Feature modules
- `@types/*` - Type definitions
- `@utils/*` - Shared utilities
- `@state/*` - State management
- `@sell/*` - Auto-sell functionality
- `@init/*` - Initialization files

## Key Architectural Principles

### 1. Feature-First Organization
- Related functionality is grouped into feature modules
- Each feature has its own barrel file for clean exports
- Features are self-contained with clear boundaries

### 2. Type Safety
- Comprehensive TypeScript interfaces and types
- Path aliases for maintainable imports
- Strict typing throughout the codebase

### 3. Safety Systems
- Non-destructive code quarantine in `/_attic/`
- Evidence-based removal with detailed tracking
- Circuit breakers for operational safety

### 4. Zero Circular Dependencies
- Clean dependency graph maintained
- Regular verification with madge
- Feature boundaries prevent circular imports

## Adding New Features

1. Create feature directory: `src/features/new-feature/`
2. Add barrel file: `src/features/new-feature/index.ts`
3. Implement feature modules with proper typing
4. Add path alias if needed: `@new-feature/*`
5. Update this documentation

## Monitoring and Observability

- **Prometheus Metrics**: Comprehensive trading and system metrics
- **Structured Logging**: JSON-formatted logs with context
- **RPC Health**: Multi-endpoint failover with health tracking
- **Position Persistence**: State continuity across restarts
- **Error Tracking**: Detailed error reporting and circuit breaking

## Safety and Risk Management

- **Portfolio Risk**: Position size and exposure limits
- **Safety Checks**: LP locks, honeypot detection, social verification
- **MEV Protection**: Jito bundles, sandwich detection, dynamic fees
- **Emergency Controls**: Circuit breakers and emergency halt systems
- **Data Persistence**: Complete state recovery capabilities