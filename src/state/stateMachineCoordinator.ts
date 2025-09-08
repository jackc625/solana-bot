// src/state/stateMachineCoordinator.ts
// Coordinates the state machine with existing bot processes

import { tokenStateMachine, TokenState, StateEvent, TokenContext } from './tokenStateMachine.js';
import { PumpToken } from '../types/PumpToken.js';
import { checkTokenSafety } from '../core/safety.js';
import { scoreToken } from '../core/scoring.js';
import { snipeToken, sellToken } from '../core/trading.js';
import dualExecutionStrategy, { ExecutionStrategy } from '../core/dualExecutionStrategy.js';
import { trackBuy } from '../sell/autoSellManager.js';
import { loadBotConfig } from '../config/index.js';
import { loadWallet, getConnection } from '../utils/solana.js';
import logger from '../utils/logger.js';
import metricsCollector from '../utils/metricsCollector.js';

export class StateMachineCoordinator {
  private readonly warmingDelay = 15_000; // 15s warming period
  private isInitialized = false;

  /**
   * Initialize the state machine coordinator
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // Setup state machine event handlers
    this.setupStateHandlers();

    // Start monitoring loops
    this.startValidationMonitor();
    this.startSafetyMonitor();
    this.startScoringMonitor();
    this.startTradingMonitor();
    this.startSellingMonitor();

    this.isInitialized = true;

    logger.info('FSM_COORDINATOR', 'State machine coordinator initialized');
  }

  /**
   * Add a new token to the state machine workflow
   */
  async addToken(token: PumpToken): Promise<void> {
    try {
      const context = tokenStateMachine.initializeToken(token);

      logger.info('FSM_COORDINATOR', 'Token added to state machine', {
        tokenId: token.mint.substring(0, 8) + '...',
        pool: token.pool,
        initialState: context.currentState,
      });
    } catch (error) {
      logger.error('FSM_COORDINATOR', 'Failed to add token to state machine', {
        tokenId: token.mint.substring(0, 8) + '...',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get processing statistics from the state machine
   */
  getStatistics() {
    return tokenStateMachine.getStatistics();
  }

  /**
   * Setup event handlers for state machine events
   */
  private setupStateHandlers(): void {
    // Handle warming completion
    tokenStateMachine.on('stateChanged', async ({ tokenId, newState, previousState, context }) => {
      try {
        switch (newState) {
          case TokenState.WARMING:
            // Start warming timer
            setTimeout(async () => {
              const currentContext = tokenStateMachine.getContext(tokenId);
              if (currentContext?.currentState === TokenState.WARMING) {
                await tokenStateMachine.transition(tokenId, StateEvent.WARM_COMPLETE);
              }
            }, this.warmingDelay);
            break;

          case TokenState.VALIDATING:
            // Validation will be handled by monitoring loop
            logger.debug('FSM_COORDINATOR', 'Token entering validation phase', {
              tokenId: tokenId.substring(0, 8) + '...',
            });
            break;

          case TokenState.COMPLETED:
          case TokenState.FAILED:
          case TokenState.TIMEOUT:
          case TokenState.REJECTED:
            // Log final outcome
            this.logFinalOutcome(context);
            break;
        }
      } catch (error) {
        logger.error('FSM_COORDINATOR', 'State handler error', {
          tokenId: tokenId.substring(0, 8) + '...',
          newState,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    // Handle capacity warnings
    tokenStateMachine.on('capacityWarning', (stats) => {
      logger.warn('FSM_COORDINATOR', 'State machine approaching capacity', stats);
    });
  }

  /**
   * Monitor tokens in VALIDATING state
   */
  private startValidationMonitor(): void {
    setInterval(async () => {
      const validatingTokens = tokenStateMachine.getContextsByState(TokenState.VALIDATING);

      for (const context of validatingTokens) {
        if (context.metadata.validationAttempts >= 3) {
          await tokenStateMachine.forceFailure(
            context.token.mint,
            'Max validation attempts exceeded',
          );
          continue;
        }

        try {
          await this.validateToken(context);
        } catch (error) {
          logger.warn('FSM_COORDINATOR', 'Token validation error', {
            tokenId: context.token.mint.substring(0, 8) + '...',
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          context.metadata.validationAttempts++;
          context.metadata.errors.push(error instanceof Error ? error.message : 'Validation error');
        }
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Monitor tokens in SAFETY_CHECK state
   */
  private startSafetyMonitor(): void {
    setInterval(async () => {
      const safetyTokens = tokenStateMachine.getContextsByState(TokenState.SAFETY_CHECK);

      for (const context of safetyTokens) {
        try {
          await this.performSafetyCheck(context);
        } catch (error) {
          logger.warn('FSM_COORDINATOR', 'Safety check error', {
            tokenId: context.token.mint.substring(0, 8) + '...',
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          await tokenStateMachine.transition(context.token.mint, StateEvent.SAFETY_FAIL, {
            error: error instanceof Error ? error.message : 'Safety check error',
          });
        }
      }
    }, 3000); // Check every 3 seconds
  }

  /**
   * Monitor tokens in SCORING state
   */
  private startScoringMonitor(): void {
    setInterval(async () => {
      const scoringTokens = tokenStateMachine.getContextsByState(TokenState.SCORING);

      for (const context of scoringTokens) {
        try {
          await this.performScoring(context);
        } catch (error) {
          logger.warn('FSM_COORDINATOR', 'Scoring error', {
            tokenId: context.token.mint.substring(0, 8) + '...',
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          await tokenStateMachine.transition(context.token.mint, StateEvent.SCORE_FAIL, {
            error: error instanceof Error ? error.message : 'Scoring error',
          });
        }
      }
    }, 2000); // Check every 2 seconds
  }

  /**
   * Monitor tokens in READY_TO_TRADE state
   */
  private startTradingMonitor(): void {
    setInterval(async () => {
      const readyTokens = tokenStateMachine.getContextsByState(TokenState.READY_TO_TRADE);

      for (const context of readyTokens) {
        try {
          // Check if we should actually trade this token
          const config = loadBotConfig();
          if (config.dryRun) {
            logger.info('FSM_COORDINATOR', 'Dry run mode - simulating trade', {
              tokenId: context.token.mint.substring(0, 8) + '...',
            });

            await tokenStateMachine.transition(context.token.mint, StateEvent.TRADE_SUCCESS, {
              dryRun: true,
              amount: config.buyAmounts[String(context.metadata.scoreResults?.score)] || 0.1,
            });
            continue;
          }

          await this.executeTrade(context);
        } catch (error) {
          logger.error('FSM_COORDINATOR', 'Trade execution error', {
            tokenId: context.token.mint.substring(0, 8) + '...',
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          await tokenStateMachine.transition(context.token.mint, StateEvent.TRADE_FAIL, {
            error: error instanceof Error ? error.message : 'Trade error',
          });
        }
      }
    }, 1000); // Check every 1 second for trading opportunities
  }

  /**
   * Monitor tokens in SELLING state
   */
  private startSellingMonitor(): void {
    setInterval(async () => {
      const sellingTokens = tokenStateMachine.getContextsByState(TokenState.SELLING);

      for (const context of sellingTokens) {
        try {
          await this.executeSell(context);
        } catch (error) {
          logger.error('FSM_COORDINATOR', 'Sell execution error', {
            tokenId: context.token.mint.substring(0, 8) + '...',
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          await tokenStateMachine.transition(context.token.mint, StateEvent.SELL_FAIL, {
            error: error instanceof Error ? error.message : 'Sell error',
          });
        }
      }
    }, 5000); // Check every 5 seconds
  }

  /**
   * Validate a token (route checking, stability, etc.)
   */
  private async validateToken(context: TokenContext): Promise<void> {
    context.metadata.validationAttempts++;

    // This would integrate with the existing retry validator logic
    // For now, simulate validation success after warming period
    const hasWarmingCompleted = Date.now() - context.metadata.discoveredAt >= this.warmingDelay;

    if (hasWarmingCompleted) {
      await tokenStateMachine.transition(context.token.mint, StateEvent.VALIDATE_SUCCESS, {
        validationAttempts: context.metadata.validationAttempts,
      });
    }
  }

  /**
   * Perform safety checks on a token
   */
  private async performSafetyCheck(context: TokenContext): Promise<void> {
    const config = loadBotConfig();
    const connection = getConnection();
    const wallet = loadWallet();

    if (!wallet) {
      await tokenStateMachine.transition(context.token.mint, StateEvent.SAFETY_FAIL, {
        error: 'No wallet available',
      });
      return;
    }

    const safetyResult = await checkTokenSafety(
      context.token,
      config,
      connection,
      wallet.publicKey,
    );

    if (safetyResult.passed) {
      await tokenStateMachine.transition(
        context.token.mint,
        StateEvent.SAFETY_SUCCESS,
        safetyResult,
      );
    } else {
      await tokenStateMachine.transition(context.token.mint, StateEvent.SAFETY_FAIL, safetyResult);
    }
  }

  /**
   * Perform token scoring
   */
  private async performScoring(context: TokenContext): Promise<void> {
    const config = loadBotConfig();

    const { score, details } = await scoreToken(context.token);

    if (score >= config.scoreThreshold) {
      await tokenStateMachine.transition(context.token.mint, StateEvent.SCORE_SUCCESS, {
        score,
        details,
        threshold: config.scoreThreshold,
      });
    } else {
      await tokenStateMachine.transition(context.token.mint, StateEvent.SCORE_FAIL, {
        score,
        details,
        threshold: config.scoreThreshold,
        reason: 'Score below threshold',
      });
    }
  }

  /**
   * Execute a trade
   */
  private async executeTrade(context: TokenContext): Promise<void> {
    const config = loadBotConfig();
    const connection = getConnection();
    const wallet = loadWallet();

    if (!wallet) {
      throw new Error('No wallet available for trading');
    }

    await tokenStateMachine.transition(context.token.mint, StateEvent.TRADE_START);

    const score = context.metadata.scoreResults?.score || 5;
    const buyAmount = config.buyAmounts[String(score)] || 0.1;

    // Execute the actual trade using dual execution strategy
    if (config.dryRun) {
      logger.info('FSM_COORDINATOR', 'Dry run mode - simulating dual execution trade', {
        tokenId: context.token.mint.substring(0, 8) + '...',
        amount: buyAmount,
        strategy: 'JITO_WITH_FALLBACK',
      });

      // Simulate trade success in dry run mode
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      // Use snipeToken with dual execution (already integrated)
      await snipeToken({
        connection,
        wallet,
        mint: context.token.mint,
        amountSOL: buyAmount,
        deployer: context.token.creator,
      });
    }

    // Track the buy for auto-sell
    trackBuy(context.token.mint, buyAmount, 0, context.token.creator);

    await tokenStateMachine.transition(
      context.token.mint,
      StateEvent.TRADE_SUCCESS,
      { buyAmount, price: 0 }, // Price would come from actual trade
    );
  }

  /**
   * Execute a sell order
   */
  private async executeSell(context: TokenContext): Promise<void> {
    const connection = getConnection();
    const wallet = loadWallet();

    if (!wallet) {
      throw new Error('No wallet available for selling');
    }

    const tradeData = context.metadata.tradeResults;
    if (!tradeData) {
      throw new Error('No trade data available for sell');
    }

    // Execute sell using dual execution strategy
    if (loadBotConfig().dryRun) {
      logger.info('FSM_COORDINATOR', 'Dry run mode - simulating dual execution sell', {
        tokenId: context.token.mint.substring(0, 8) + '...',
        amount: tradeData.buyAmount,
        strategy: 'JITO_WITH_FALLBACK',
      });

      await tokenStateMachine.transition(context.token.mint, StateEvent.SELL_SUCCESS, {
        sellAmount: tradeData.buyAmount,
        dryRun: true,
      });
    } else {
      // Use sellToken with dual execution (already integrated)
      await sellToken({
        connection,
        wallet,
        mint: context.token.mint,
        amountTokens: tradeData.buyAmount, // This would be token amount, not SOL
      });

      await tokenStateMachine.transition(context.token.mint, StateEvent.SELL_SUCCESS, {
        sellAmount: tradeData.buyAmount,
      });
    }
  }

  /**
   * Log the final outcome of token processing
   */
  private logFinalOutcome(context: TokenContext): void {
    const duration = Date.now() - context.metadata.discoveredAt;
    const tokenId = context.token.mint.substring(0, 8) + '...';

    const outcomeData = {
      tokenId,
      finalState: context.currentState,
      duration: `${(duration / 1000).toFixed(1)}s`,
      retries: context.retryCount,
      errors: context.metadata.errors.length,
      warnings: context.metadata.warnings.length,
    };

    switch (context.currentState) {
      case TokenState.COMPLETED:
        logger.info('FSM_COORDINATOR', 'Token processing completed successfully', outcomeData);
        break;
      case TokenState.FAILED:
        logger.warn('FSM_COORDINATOR', 'Token processing failed', {
          ...outcomeData,
          lastError: context.metadata.errors[context.metadata.errors.length - 1],
        });
        break;
      case TokenState.TIMEOUT:
        logger.warn('FSM_COORDINATOR', 'Token processing timed out', outcomeData);
        break;
      case TokenState.REJECTED:
        logger.info('FSM_COORDINATOR', 'Token rejected by filters', {
          ...outcomeData,
          rejectionReason: context.metadata.errors[context.metadata.errors.length - 1],
        });
        break;
    }

    // Record final metrics
    const outcome = context.currentState === TokenState.COMPLETED ? 'success' : 'failure';
    metricsCollector.recordTradingOperation('buy', outcome, duration);
  }
}

// Export singleton instance
export const stateMachineCoordinator = new StateMachineCoordinator();

export default stateMachineCoordinator;
