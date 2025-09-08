# Architecture Overview

## Current State (Pre-Refactoring)

This document describes the architectural decisions and structure of the Solana trading bot.

**Status**: This is a living document that will be updated throughout the refactoring process.

## High-Level Architecture

### Core Components

- **Token Discovery**: WebSocket monitoring of Pump.fun launches
- **Validation Pipeline**: Route checking and stability validation
- **Safety Systems**: LP locks, honeypot detection, social verification
- **MEV Protection**: Sandwich detection, priority fee optimization, Jito bundles
- **Trade Execution**: Multi-RPC failover, transaction preparation
- **Portfolio Management**: Risk controls, position tracking, auto-sell strategies
- **Monitoring**: Metrics collection, alerting, performance tracking

### Data Flow

1. Token Discovery → Validation → Safety Checks → MEV Analysis → Trade Execution
2. Position Tracking → Risk Management → Auto-sell Management
3. Metrics Collection → Monitoring → Alerting

## Module Organization

### Current Structure (Phase 2)

```
src/
├── core/           # Business logic modules
├── utils/          # Mixed utilities and services
├── state/          # State management
├── config/         # Configuration
├── types/          # TypeScript definitions
└── sell/           # Auto-sell functionality
```

### Target Structure (Post-Refactoring)

```
src/
├── features/       # Feature-based modules
│   ├── discovery/
│   ├── validation/
│   ├── safety/
│   ├── mev/
│   ├── execution/
│   ├── autosell/
│   └── telemetry/
├── core/           # Shared business logic
│   ├── clients/
│   ├── portfolio/
│   └── state/
├── config/         # Configuration & validation
├── types/          # TypeScript definitions
└── utils/          # Pure utilities only
```

## Key Design Principles

1. **Feature-First Organization**: Group related functionality together
2. **Clear Boundaries**: Well-defined interfaces between modules
3. **Dependency Injection**: Avoid tight coupling between components
4. **Event-Driven**: Use events for cross-cutting concerns
5. **Testability**: All components easily mockable and testable

## Technology Stack

- **Runtime**: Node.js 20.x with ES modules
- **Language**: TypeScript (strict mode)
- **Testing**: Jest with ESM support
- **Blockchain**: Solana Web3.js, Jupiter SDK, Jito bundles
- **Monitoring**: Prometheus metrics, custom logging

---

_This document will be expanded as the refactoring progresses._
