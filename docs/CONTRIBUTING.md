# Contributing Guide

## Development Setup

### Prerequisites

- Node.js 20.x LTS
- npm (comes with Node.js)
- Git

### Getting Started

```bash
git clone <repository>
cd solana-bot
npm install
npm run check  # Verify everything works
```

## Code Organization

### How We Organize Code

This project uses a **feature-first architecture** where related functionality is grouped together:

```
src/features/discovery/    # Token discovery logic
src/features/safety/       # Safety validation systems
src/features/execution/    # Trade execution
# ... etc
```

### Coding Standards

- **TypeScript**: Strict mode enabled, no implicit any
- **ESM Only**: Use ES modules (`import`/`export`)
- **File Size**: Keep files ≤400 lines, functions ≤60 lines
- **Naming**: Use descriptive names, avoid abbreviations
- **Imports**: Use path aliases (`@features/`, `@core/`, etc.)

## Development Workflow

### Before Making Changes

```bash
npm run check  # Lint + typecheck + test + build
```

### Making Changes

1. Create a feature branch: `git checkout -b feature/your-change`
2. Make small, focused commits
3. Run tests: `npm test`
4. Run full check: `npm run check`
5. Push and create PR

### Code Style

- **Formatting**: Prettier (auto-formats on save)
- **Linting**: ESLint (catches issues)
- **Import Order**: Node builtins → externals → internals
- **Semicolons**: Required
- **Quotes**: Single quotes preferred

## Testing

### Test Structure

```
test/
├── unit/           # Fast, isolated unit tests
├── integration/    # Integration tests with real dependencies
└── fixtures/       # Test data and mocks
```

### Running Tests

```bash
npm test            # Run all tests
npm run test:watch  # Watch mode
npm run test:coverage  # With coverage report
```

### Writing Tests

- Import Jest globals from `@jest/globals`
- Use descriptive test names
- Mock external dependencies
- Test both success and error cases

## Code Quality

### Pre-commit Checklist

- [ ] Code formatted with Prettier
- [ ] ESLint passes with no errors
- [ ] TypeScript compiles without errors
- [ ] All tests pass
- [ ] No unused imports/variables

### Performance Considerations

- Avoid blocking the event loop
- Use connection pooling for RPC calls
- Cache expensive computations
- Monitor memory usage

## Architecture Guidelines

### Module Dependencies

- Features can depend on `@core/` and `@utils/`
- Core modules should not depend on features
- Avoid circular dependencies
- Use interfaces for loose coupling

### Error Handling

- Use typed errors with context
- Log errors with appropriate levels
- Handle network failures gracefully
- Provide meaningful error messages

---

_This guide will be expanded as the codebase evolves._
