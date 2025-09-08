# Architectural Decision Records (ADR)

This document tracks key architectural decisions made during the development and restructuring of the Solana trading bot.

## ADR-001: Feature-First Directory Structure

**Date**: Phase 4-5 Restructuring  
**Status**: Accepted  
**Context**: Original codebase had all functionality mixed in utils/ and core/ directories, making it hard to understand feature boundaries and maintain related code together.

**Decision**: Adopt feature-first organization where related functionality is grouped into feature modules under `src/features/`:

- `src/features/mev/` - MEV protection and Jito integration
- `src/features/execution/` - Trade execution strategies  
- `src/features/telemetry/` - Metrics and monitoring
- `src/features/validation/` - Token validation logic
- `src/features/discovery/` - Token discovery and watchlist
- `src/features/safety/` - Safety checks and verification

**Consequences**:
- ✅ Clear feature boundaries and ownership
- ✅ Related code co-located for easier maintenance
- ✅ Better encapsulation with barrel exports
- ⚠️ Initial migration effort required

## ADR-002: Path Aliases for Import Management

**Date**: Phase 5  
**Status**: Accepted  
**Context**: Deep relative imports (`../../../utils/something`) made refactoring difficult and imports brittle.

**Decision**: Implement comprehensive path alias system:
```typescript
"@/*": ["*"],
"@config/*": ["config/*"],
"@core/*": ["core/*"],
"@features/*": ["features/*"],
"@types/*": ["types/*"],
"@utils/*": ["utils/*"],
"@state/*": ["state/*"],
"@sell/*": ["sell/*"],
"@init/*": ["init/*"]
```

**Consequences**:
- ✅ Imports remain stable during refactoring
- ✅ Cleaner, more readable import statements
- ✅ IDE auto-completion and navigation
- ✅ Easier to understand dependencies

## ADR-003: Non-Destructive Code Quarantine

**Date**: Phase 5  
**Status**: Accepted  
**Context**: Need to safely remove potentially unused code without risking runtime breakage.

**Decision**: Implement attic-based quarantine system:
1. Move potentially unused files to `/_attic/` maintaining directory structure
2. Create stub files at original locations with re-exports if needed
3. Monitor for runtime issues over time
4. Delete permanently only after verification period

**Consequences**:
- ✅ Zero risk of breaking changes during cleanup
- ✅ Easy restoration if files are needed
- ✅ Evidence-based removal with full traceability
- ⚠️ Additional storage overhead during transition

## ADR-004: TypeScript Strict Mode with Interface Normalization

**Date**: Phase 5  
**Status**: Accepted  
**Context**: TypeScript errors were accumulating due to interface mismatches and missing properties.

**Decision**: Maintain strict TypeScript configuration and normalize key interfaces:
- Add missing properties like `PumpToken.discoveredAt`
- Ensure interface consistency across modules
- Fix method signatures to match actual usage
- Target ≤10 TypeScript errors as quality gate

**Consequences**:
- ✅ Better type safety and runtime reliability
- ✅ Improved developer experience with accurate IntelliSense
- ✅ Early error detection
- ⚠️ Requires ongoing interface maintenance

## ADR-005: Barrel Exports for Feature Modules

**Date**: Phase 5  
**Status**: Accepted  
**Context**: Feature modules need clean public APIs and internal implementation hiding.

**Decision**: Use barrel files (`index.ts`) in each feature directory:
```typescript
// src/features/mev/index.ts
export * from './mevProtection.js';
export * from './jitoBundle.js';
// ... other exports
```

**Consequences**:
- ✅ Clean public API for each feature
- ✅ Internal implementation can change without affecting consumers  
- ✅ Single import point per feature
- ⚠️ Potential for circular dependencies if not managed carefully

## ADR-006: Evidence-Based Dependency Management

**Date**: Phase 5  
**Status**: Accepted  
**Context**: Package.json contained unused dependencies that add security risk and bundle size.

**Decision**: Use static analysis tools (knip, depcheck, ts-prune) to identify truly unused dependencies before removal:

**Dependencies marked for removal** (awaiting approval):
- `@jup-ag/api` - Not directly used (may be transitive)
- `@metaplex-foundation/mpl-token-metadata` - Not used
- `node-telegram-bot-api` - Telegram functionality not implemented
- `rpc-websockets` - Not used with current RPC setup  
- `socket.io-client` - Not used

**DevDependencies for removal**:
- `@types/bn.js`, `@types/bs58` - Type definitions not needed
- `@types/node-telegram-bot-api` - For unused package
- `jest-environment-node` - Not configured
- `tsx` - TypeScript runner not used

**Consequences**:
- ✅ Smaller bundle size and attack surface
- ✅ Cleaner dependency graph
- ✅ Evidence-based decisions prevent accidental removal
- ⚠️ Requires verification that dependencies are truly unused

## ADR-007: Zero Circular Dependency Policy

**Date**: Phase 4-5  
**Status**: Accepted  
**Context**: Circular dependencies cause build issues, runtime problems, and make code harder to reason about.

**Decision**: Maintain zero circular dependencies as verified by madge:
```bash
npm run graph:cycles  # Must show "No circular dependency found!"
```

**Consequences**:
- ✅ Predictable module loading and initialization
- ✅ Better separation of concerns
- ✅ Easier testing and mocking
- ✅ Cleaner architecture
- ⚠️ Requires careful design of module boundaries

## Decision Status

- **Accepted**: Decision is active and should be followed
- **Deprecated**: Decision is no longer recommended
- **Superseded**: Decision has been replaced by newer ADR