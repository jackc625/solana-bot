# Solana Trading Bot

A production-grade Solana trading bot that automatically discovers, evaluates, and trades new tokens on the Pump.fun platform with comprehensive safety systems, risk management, and monitoring infrastructure.

## Features

- **Token Discovery**: Real-time monitoring of Pump.fun WebSocket feeds
- **Multi-stage Validation**: Route checking, stability validation, safety analysis
- **Comprehensive Safety**: LP lock verification, honeypot detection, social verification
- **MEV Protection**: Sandwich attack detection, Jito bundle execution, priority fee optimization
- **Risk Management**: Portfolio limits, position tracking, circuit breakers
- **Auto-sell Strategies**: Take profit, stop loss, trailing stops, time-based exits
- **Production Monitoring**: Prometheus metrics, Grafana dashboards, real-time alerting

## Quick Start

### Prerequisites

- Node.js 20.x LTS
- npm
- Solana wallet with funds

### Installation

```bash
git clone <repository>
cd solana-bot
npm install
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your wallet private key and RPC endpoint
```

### Development Commands

```bash
# Run the bot
npm start

# Development workflow
npm run check          # Run all checks (lint + typecheck + test + build)
npm run lint           # Check code style
npm run format         # Auto-format code
npm run typecheck      # TypeScript compilation check
npm run test           # Run test suite
npm run build          # Build TypeScript

# Testing
npm run test:watch     # Watch mode
npm run test:coverage  # With coverage report
```

## Architecture

This bot uses a **feature-first architecture** for maintainability and scalability:

```
src/
├── features/          # Feature-based modules
│   ├── discovery/     # Token discovery & monitoring
│   ├── validation/    # Route & stability validation
│   ├── safety/        # LP locks, honeypot, social checks
│   ├── mev/          # MEV protection systems
│   ├── execution/    # Trade execution & RPC management
│   ├── autosell/     # Exit strategies
│   └── telemetry/    # Metrics & monitoring
├── core/             # Shared business logic
├── config/           # Configuration & validation
├── types/            # TypeScript definitions
└── utils/            # Pure utilities
```

For detailed architecture information, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

The bot is configured via `src/config/botConfig.json`:

- **Trading Parameters**: Buy amounts, slippage, position limits
- **Safety Settings**: LP lock requirements, honeypot detection sensitivity
- **Risk Management**: Portfolio limits, daily loss limits, circuit breakers
- **MEV Protection**: Protection levels, Jito bundle configuration
- **Monitoring**: Metrics collection, alerting thresholds

## Safety Features

- **Multi-RPC Failover**: Eliminates single points of failure
- **Comprehensive Token Analysis**: LP locks, mint/freeze authorities, holder distribution
- **MEV Protection**: 4-tier protection system with Jito bundles
- **Position Limits**: Maximum position size and portfolio exposure
- **Circuit Breakers**: Emergency halt conditions
- **State Persistence**: Complete recovery across restarts

## Development

### Code Standards

- TypeScript strict mode
- ESM modules only
- Path aliases (`@features/`, `@core/`, etc.)
- File size limits (≤400 lines)
- Comprehensive test coverage

### Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for detailed guidelines.

### Architecture Decisions

See [docs/DECISIONS.md](docs/DECISIONS.md) for architectural decision records.

## Monitoring

- **Prometheus Metrics**: Real-time performance tracking
- **Grafana Dashboards**: Visual monitoring and alerting
- **Structured Logging**: Comprehensive audit trails
- **Error Tracking**: Automatic error collection and analysis

## Production Deployment

⚠️ **Always test in dry-run mode first**: Set `"dryRun": true` in `botConfig.json`

For production deployment, see [DEPLOYMENT.md](DEPLOYMENT.md).

## License

ISC License

---

**⚠️ Risk Disclaimer**: This software handles real cryptocurrency transactions. Use at your own risk. Always test thoroughly in dry-run mode before live trading.
