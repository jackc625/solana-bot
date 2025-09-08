// src/state/tokenStateMachine.ts
// Finite State Machine for token processing with per-state timeouts and guaranteed progression

import { EventEmitter } from 'events';
import { PumpToken } from '../types/PumpToken.js';
import logger from '../utils/logger.js';
import metricsCollector from '../utils/metricsCollector.js';

// Token processing states
export enum TokenState {
  DISCOVERED = 'DISCOVERED', // Token just discovered via WebSocket
  WARMING = 'WARMING', // In warming period before validation
  VALIDATING = 'VALIDATING', // Route/liquidity validation in progress
  SAFETY_CHECK = 'SAFETY_CHECK', // Safety checks in progress
  SCORING = 'SCORING', // Token scoring in progress
  READY_TO_TRADE = 'READY_TO_TRADE', // Passed all checks, ready for trade
  TRADING = 'TRADING', // Trade execution in progress
  POSITION_HELD = 'POSITION_HELD', // Successfully bought, position active
  SELLING = 'SELLING', // Sell order in progress
  COMPLETED = 'COMPLETED', // Successfully sold
  FAILED = 'FAILED', // Failed at any stage
  TIMEOUT = 'TIMEOUT', // Timed out in any state
  REJECTED = 'REJECTED', // Rejected by safety/scoring
}

// State transition events
export enum StateEvent {
  WARM_START = 'WARM_START',
  WARM_COMPLETE = 'WARM_COMPLETE',
  VALIDATE_START = 'VALIDATE_START',
  VALIDATE_SUCCESS = 'VALIDATE_SUCCESS',
  VALIDATE_FAIL = 'VALIDATE_FAIL',
  SAFETY_START = 'SAFETY_START',
  SAFETY_SUCCESS = 'SAFETY_SUCCESS',
  SAFETY_FAIL = 'SAFETY_FAIL',
  SCORE_START = 'SCORE_START',
  SCORE_SUCCESS = 'SCORE_SUCCESS',
  SCORE_FAIL = 'SCORE_FAIL',
  TRADE_START = 'TRADE_START',
  TRADE_SUCCESS = 'TRADE_SUCCESS',
  TRADE_FAIL = 'TRADE_FAIL',
  HOLD_START = 'HOLD_START',
  SELL_START = 'SELL_START',
  SELL_SUCCESS = 'SELL_SUCCESS',
  SELL_FAIL = 'SELL_FAIL',
  TIMEOUT_OCCURRED = 'TIMEOUT_OCCURRED',
  FORCE_FAIL = 'FORCE_FAIL',
  FORCE_REJECT = 'FORCE_REJECT',
}

// Per-state timeout configuration (in milliseconds)
const STATE_TIMEOUTS: Record<TokenState, number> = {
  [TokenState.DISCOVERED]: 1000, // Quick transition
  [TokenState.WARMING]: 20_000, // 20s warming period
  [TokenState.VALIDATING]: 30_000, // 30s for route validation
  [TokenState.SAFETY_CHECK]: 45_000, // 45s for safety checks
  [TokenState.SCORING]: 10_000, // 10s for scoring
  [TokenState.READY_TO_TRADE]: 5_000, // 5s buffer before trade
  [TokenState.TRADING]: 60_000, // 60s for trade execution
  [TokenState.POSITION_HELD]: 0, // No timeout - held until sell trigger
  [TokenState.SELLING]: 60_000, // 60s for sell execution
  [TokenState.COMPLETED]: 0, // Terminal state
  [TokenState.FAILED]: 0, // Terminal state
  [TokenState.TIMEOUT]: 0, // Terminal state
  [TokenState.REJECTED]: 0, // Terminal state
};

// Valid state transitions
const STATE_TRANSITIONS: Record<TokenState, StateEvent[]> = {
  [TokenState.DISCOVERED]: [StateEvent.WARM_START, StateEvent.FORCE_FAIL, StateEvent.FORCE_REJECT],
  [TokenState.WARMING]: [
    StateEvent.WARM_COMPLETE,
    StateEvent.TIMEOUT_OCCURRED,
    StateEvent.FORCE_FAIL,
  ],
  [TokenState.VALIDATING]: [
    StateEvent.VALIDATE_SUCCESS,
    StateEvent.VALIDATE_FAIL,
    StateEvent.TIMEOUT_OCCURRED,
  ],
  [TokenState.SAFETY_CHECK]: [
    StateEvent.SAFETY_SUCCESS,
    StateEvent.SAFETY_FAIL,
    StateEvent.TIMEOUT_OCCURRED,
  ],
  [TokenState.SCORING]: [
    StateEvent.SCORE_SUCCESS,
    StateEvent.SCORE_FAIL,
    StateEvent.TIMEOUT_OCCURRED,
  ],
  [TokenState.READY_TO_TRADE]: [
    StateEvent.TRADE_START,
    StateEvent.TIMEOUT_OCCURRED,
    StateEvent.FORCE_FAIL,
  ],
  [TokenState.TRADING]: [
    StateEvent.TRADE_SUCCESS,
    StateEvent.TRADE_FAIL,
    StateEvent.TIMEOUT_OCCURRED,
  ],
  [TokenState.POSITION_HELD]: [StateEvent.SELL_START, StateEvent.FORCE_FAIL],
  [TokenState.SELLING]: [
    StateEvent.SELL_SUCCESS,
    StateEvent.SELL_FAIL,
    StateEvent.TIMEOUT_OCCURRED,
  ],
  [TokenState.COMPLETED]: [], // Terminal
  [TokenState.FAILED]: [], // Terminal
  [TokenState.TIMEOUT]: [], // Terminal
  [TokenState.REJECTED]: [], // Terminal
};

export interface TokenContext {
  token: PumpToken;
  currentState: TokenState;
  previousState?: TokenState;
  stateEntryTime: number;
  totalProcessingTime: number;
  timeoutHandle?: NodeJS.Timeout;
  retryCount: number;
  maxRetries: number;
  metadata: {
    discoveredAt: number;
    validationAttempts: number;
    safetyCheckResults?: any;
    scoreResults?: any;
    tradeResults?: any;
    sellResults?: any;
    errors: string[];
    warnings: string[];
  };
}

export interface StateTransitionResult {
  success: boolean;
  newState: TokenState;
  reason?: string;
  shouldRetry?: boolean;
  data?: any;
}

class TokenStateMachine extends EventEmitter {
  private contexts: Map<string, TokenContext> = new Map();
  private readonly MAX_CONCURRENT_TOKENS = 50;
  private readonly CLEANUP_INTERVAL_MS = 60_000; // 1 minute
  private cleanupTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.startCleanupTimer();
    this.setupEventHandlers();
  }

  /**
   * Initialize a new token in the state machine
   */
  initializeToken(token: PumpToken): TokenContext {
    const tokenId = token.mint;

    // Check capacity
    if (this.contexts.size >= this.MAX_CONCURRENT_TOKENS) {
      this.cleanupStaleContexts();
    }

    if (this.contexts.size >= this.MAX_CONCURRENT_TOKENS) {
      throw new Error(`Token processing capacity exceeded (${this.MAX_CONCURRENT_TOKENS})`);
    }

    const context: TokenContext = {
      token,
      currentState: TokenState.DISCOVERED,
      stateEntryTime: Date.now(),
      totalProcessingTime: 0,
      retryCount: 0,
      maxRetries: 3,
      metadata: {
        discoveredAt: token.discoveredAt || Date.now(),
        validationAttempts: 0,
        errors: [],
        warnings: [],
      },
    };

    this.contexts.set(tokenId, context);
    this.scheduleTimeout(context);

    logger.info('TOKEN_FSM', 'Token initialized in state machine', {
      tokenId: tokenId.substring(0, 8) + '...',
      state: TokenState.DISCOVERED,
      totalTokens: this.contexts.size,
    });

    // Emit initialization event
    this.emit('tokenInitialized', context);

    return context;
  }

  /**
   * Transition a token to a new state based on an event
   */
  async transition(tokenId: string, event: StateEvent, data?: any): Promise<StateTransitionResult> {
    const context = this.contexts.get(tokenId);

    if (!context) {
      return {
        success: false,
        newState: TokenState.FAILED,
        reason: 'Token context not found',
      };
    }

    const currentState = context.currentState;
    const validTransitions = STATE_TRANSITIONS[currentState] || [];

    if (!validTransitions.includes(event)) {
      const error = `Invalid transition: ${event} from state ${currentState}`;
      context.metadata.errors.push(error);

      logger.warn('TOKEN_FSM', 'Invalid state transition attempted', {
        tokenId: tokenId.substring(0, 8) + '...',
        currentState,
        event,
        validTransitions,
      });

      return {
        success: false,
        newState: currentState,
        reason: error,
      };
    }

    // Calculate new state based on event
    const newState = this.calculateNewState(currentState, event);
    const previousState = currentState;
    const now = Date.now();

    // Update context
    context.previousState = previousState;
    context.currentState = newState;
    context.totalProcessingTime += now - context.stateEntryTime;
    context.stateEntryTime = now;

    // Clear existing timeout and set new one if needed
    this.clearTimeout(context);
    this.scheduleTimeout(context);

    // Store transition data
    if (data) {
      switch (event) {
        case StateEvent.SAFETY_SUCCESS:
          context.metadata.safetyCheckResults = data;
          break;
        case StateEvent.SCORE_SUCCESS:
          context.metadata.scoreResults = data;
          break;
        case StateEvent.TRADE_SUCCESS:
          context.metadata.tradeResults = data;
          break;
        case StateEvent.SELL_SUCCESS:
          context.metadata.sellResults = data;
          break;
      }
    }

    // Log transition
    logger.info('TOKEN_FSM', 'State transition completed', {
      tokenId: tokenId.substring(0, 8) + '...',
      transition: `${previousState} → ${newState}`,
      event,
      stateTime: `${now - context.stateEntryTime}ms`,
      totalTime: `${context.totalProcessingTime}ms`,
      retryCount: context.retryCount,
    });

    // Record metrics
    metricsCollector.recordStateMachineMetric(newState, event);

    // Emit state change event
    this.emit('stateChanged', {
      tokenId,
      previousState,
      newState,
      event,
      context,
      data,
    });

    // Handle special states
    if (this.isTerminalState(newState)) {
      this.handleTerminalState(context);
    }

    return {
      success: true,
      newState,
      reason: `Transitioned via ${event}`,
    };
  }

  /**
   * Get the current context for a token
   */
  getContext(tokenId: string): TokenContext | undefined {
    return this.contexts.get(tokenId);
  }

  /**
   * Get all contexts in a specific state
   */
  getContextsByState(state: TokenState): TokenContext[] {
    return Array.from(this.contexts.values()).filter((ctx) => ctx.currentState === state);
  }

  /**
   * Force a token to failed state
   */
  async forceFailure(tokenId: string, reason: string): Promise<void> {
    const context = this.contexts.get(tokenId);
    if (!context) return;

    context.metadata.errors.push(reason);
    await this.transition(tokenId, StateEvent.FORCE_FAIL);
  }

  /**
   * Force a token to rejected state
   */
  async forceReject(tokenId: string, reason: string): Promise<void> {
    const context = this.contexts.get(tokenId);
    if (!context) return;

    context.metadata.errors.push(reason);
    await this.transition(tokenId, StateEvent.FORCE_REJECT);
  }

  /**
   * Get processing statistics
   */
  getStatistics() {
    const contexts = Array.from(this.contexts.values());
    const stateDistribution: Record<string, number> = {};

    // Count tokens by state
    Object.values(TokenState).forEach((state) => {
      stateDistribution[state] = contexts.filter((ctx) => ctx.currentState === state).length;
    });

    const totalProcessingTimes = contexts
      .map((ctx) => ctx.totalProcessingTime)
      .filter((t) => t > 0);
    const avgProcessingTime =
      totalProcessingTimes.length > 0
        ? totalProcessingTimes.reduce((a, b) => a + b, 0) / totalProcessingTimes.length
        : 0;

    return {
      totalTokens: this.contexts.size,
      stateDistribution,
      averageProcessingTime: avgProcessingTime,
      maxConcurrentTokens: this.MAX_CONCURRENT_TOKENS,
      capacityUsed: ((this.contexts.size / this.MAX_CONCURRENT_TOKENS) * 100).toFixed(1) + '%',
    };
  }

  /**
   * Calculate the new state based on current state and event
   */
  private calculateNewState(currentState: TokenState, event: StateEvent): TokenState {
    switch (event) {
      case StateEvent.WARM_START:
        return TokenState.WARMING;
      case StateEvent.WARM_COMPLETE:
        return TokenState.VALIDATING;
      case StateEvent.VALIDATE_START:
        return TokenState.VALIDATING;
      case StateEvent.VALIDATE_SUCCESS:
        return TokenState.SAFETY_CHECK;
      case StateEvent.VALIDATE_FAIL:
        return TokenState.FAILED;
      case StateEvent.SAFETY_START:
        return TokenState.SAFETY_CHECK;
      case StateEvent.SAFETY_SUCCESS:
        return TokenState.SCORING;
      case StateEvent.SAFETY_FAIL:
        return TokenState.REJECTED;
      case StateEvent.SCORE_START:
        return TokenState.SCORING;
      case StateEvent.SCORE_SUCCESS:
        return TokenState.READY_TO_TRADE;
      case StateEvent.SCORE_FAIL:
        return TokenState.REJECTED;
      case StateEvent.TRADE_START:
        return TokenState.TRADING;
      case StateEvent.TRADE_SUCCESS:
        return TokenState.POSITION_HELD;
      case StateEvent.TRADE_FAIL:
        return TokenState.FAILED;
      case StateEvent.HOLD_START:
        return TokenState.POSITION_HELD;
      case StateEvent.SELL_START:
        return TokenState.SELLING;
      case StateEvent.SELL_SUCCESS:
        return TokenState.COMPLETED;
      case StateEvent.SELL_FAIL:
        return TokenState.FAILED;
      case StateEvent.TIMEOUT_OCCURRED:
        return TokenState.TIMEOUT;
      case StateEvent.FORCE_FAIL:
        return TokenState.FAILED;
      case StateEvent.FORCE_REJECT:
        return TokenState.REJECTED;
      default:
        return currentState;
    }
  }

  /**
   * Schedule a timeout for the current state
   */
  private scheduleTimeout(context: TokenContext): void {
    const timeoutMs = STATE_TIMEOUTS[context.currentState];

    if (timeoutMs > 0) {
      context.timeoutHandle = setTimeout(async () => {
        const tokenId = context.token.mint;
        logger.warn('TOKEN_FSM', 'State timeout occurred', {
          tokenId: tokenId.substring(0, 8) + '...',
          state: context.currentState,
          timeoutMs,
          totalTime: Date.now() - context.metadata.discoveredAt,
        });

        context.metadata.errors.push(
          `Timeout in state ${context.currentState} after ${timeoutMs}ms`,
        );
        await this.transition(tokenId, StateEvent.TIMEOUT_OCCURRED);
      }, timeoutMs);
    }
  }

  /**
   * Clear the timeout for a context
   */
  private clearTimeout(context: TokenContext): void {
    if (context.timeoutHandle) {
      clearTimeout(context.timeoutHandle);
      context.timeoutHandle = undefined;
    }
  }

  /**
   * Check if a state is terminal (no further transitions)
   */
  private isTerminalState(state: TokenState): boolean {
    return [
      TokenState.COMPLETED,
      TokenState.FAILED,
      TokenState.TIMEOUT,
      TokenState.REJECTED,
    ].includes(state);
  }

  /**
   * Handle cleanup when a token reaches a terminal state
   */
  private handleTerminalState(context: TokenContext): void {
    this.clearTimeout(context);

    const tokenId = context.token.mint;
    const finalProcessingTime = Date.now() - context.metadata.discoveredAt;

    // Log final state
    logger.info('TOKEN_FSM', 'Token reached terminal state', {
      tokenId: tokenId.substring(0, 8) + '...',
      finalState: context.currentState,
      totalProcessingTime: `${finalProcessingTime}ms`,
      retryCount: context.retryCount,
      errors: context.metadata.errors.length,
      warnings: context.metadata.warnings.length,
    });

    // Record final metrics
    const outcome = context.currentState === TokenState.COMPLETED ? 'success' : 'failure';
    metricsCollector.recordStateMachineMetric('FINAL', outcome);
    metricsCollector.recordTradingOperation('buy', outcome, finalProcessingTime);

    // Schedule cleanup after a brief delay to allow event handlers to complete
    setTimeout(() => {
      this.contexts.delete(tokenId);
    }, 5000);
  }

  /**
   * Setup event handlers for automatic state progression
   */
  private setupEventHandlers(): void {
    // Auto-progress from DISCOVERED to WARMING
    this.on('tokenInitialized', async (context: TokenContext) => {
      setTimeout(async () => {
        await this.transition(context.token.mint, StateEvent.WARM_START);
      }, 100);
    });
  }

  /**
   * Start the cleanup timer for stale contexts
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleContexts();
    }, this.CLEANUP_INTERVAL_MS);
  }

  /**
   * Clean up stale contexts that may be stuck
   */
  private cleanupStaleContexts(): void {
    const now = Date.now();
    const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
    let cleanedCount = 0;

    for (const [tokenId, context] of this.contexts.entries()) {
      const age = now - context.metadata.discoveredAt;

      if (age > STALE_THRESHOLD_MS && !this.isTerminalState(context.currentState)) {
        logger.warn('TOKEN_FSM', 'Cleaning up stale token context', {
          tokenId: tokenId.substring(0, 8) + '...',
          state: context.currentState,
          age: `${Math.round(age / 1000)}s`,
        });

        this.clearTimeout(context);
        this.contexts.delete(tokenId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.info('TOKEN_FSM', 'Stale context cleanup completed', {
        contextsCleaned: cleanedCount,
        remainingContexts: this.contexts.size,
      });
    }
  }

  /**
   * Shutdown the state machine gracefully
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Clear all timeouts
    for (const context of this.contexts.values()) {
      this.clearTimeout(context);
    }

    this.contexts.clear();
    this.removeAllListeners();

    logger.info('TOKEN_FSM', 'State machine shutdown completed');
  }
}

// Export singleton instance
export const tokenStateMachine = new TokenStateMachine();

export default tokenStateMachine;
