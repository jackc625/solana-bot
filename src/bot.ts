// src/bot.ts

import "./init/fetchPatch.js";
import { loadBotConfig } from "./config/index.js";
import { connection, loadWallet, getWalletAddress, RPC_URL, getConnection } from "./utils/solana.js";
import rpcManager from "./utils/rpcManager.js";
import { checkTokenSafety } from "./core/safety.js";
import { scoreToken } from "./core/scoring.js";
import { snipeToken, getCurrentPriceViaJupiter } from "./core/trading.js";
import {
    trackBuy,
    configureAutoSell,
    runAutoSellLoop,
    initAutoSellConfig,
    restorePositionsFromPersistence
} from "./sell/autoSellManager.js";
import positionPersistence from "./utils/positionPersistence.js";
import portfolioRiskManager from "./core/portfolioRiskManager.js";
import metricsCollector from "./utils/metricsCollector.js";
import { metricsServer } from "./utils/metricsServer.js";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { sleep } from "./utils/time.js";
import { jupiterQueue } from "./utils/jupiter.js";
import { startRetryValidator } from "./core/retryValidator.js";
import { pendingTokens } from "./state/pendingTokens.js";
import { sendTelegramMessage, startTelegramBot } from "./utils/telegram.js";
import { normalizeMint } from "./utils/normalizeMint.js";
import {monitorPumpPortal} from "./utils/pumpPortalSocket.js";
import { PumpToken } from "./types/PumpToken.js";
import { 
    validateEnvironment, 
    validateRpcConnection, 
    validateTelegramConfig, 
    printValidationResults 
} from "./utils/validateEnvironment.js";
import logger from "./utils/logger.js";


let lastSnipeTime = 0;
const SNIPE_COOLDOWN_MS = 60_000;
let totalBuys = 0;
const MAX_BUYS = 1;
const recentlyQuoted = new Set<string>();
let recentQuotes: string[] = [];

async function main() {
    process.on("uncaughtException", (err) => {
        console.error("Uncaught Exception:", err);
    });

    process.on("unhandledRejection", (reason, promise) => {
        console.error("Unhandled Rejection:", reason);
    });

    // Environment validation - fail fast if misconfigured
    console.log("🔍 Validating environment...");
    const envValidation = validateEnvironment();
    printValidationResults(envValidation);

    if (!envValidation.valid) {
        console.error("💥 Environment validation failed. Please fix the above errors before starting the bot.");
        process.exit(1);
    }

    // Initialize Multi-RPC Manager
    console.log("🌐 Initializing RPC Manager...");
    try {
        await rpcManager.initialize();
        console.log("✅ RPC Manager initialized successfully");
        
        // Show RPC health summary
        const healthSummary = rpcManager.getHealthSummary() as any;
        console.log(`📊 RPC Status: ${healthSummary.healthyEndpoints}/${healthSummary.totalEndpoints} healthy, using ${healthSummary.currentRpc}`);
        
    } catch (error) {
        console.warn("⚠️  RPC Manager initialization failed, falling back to single RPC", (error as Error).message);
        
        // Fallback: Test single RPC connection
        console.log("🌐 Testing fallback RPC connection...");
        const rpcTest = await validateRpcConnection();
        if (!rpcTest.valid) {
            console.error(`❌ RPC connection failed: ${rpcTest.error}`);
            console.error("💥 Cannot continue without a working RPC connection.");
            process.exit(1);
        }
        console.log(`✅ Fallback RPC connection successful (latency: ${rpcTest.latency}ms)`);
    }
    
    // Show which RPC configuration is being used
    const useMainnet = process.env.USE_MAINNET === 'true';
    const rpcInUse = useMainnet 
        ? (process.env.RPC_HTTP_MAINNET || process.env.RPC_URL)
        : (process.env.RPC_HTTP_DEVNET || process.env.RPC_URL);
    console.log(`🔌 Using ${useMainnet ? 'MAINNET' : 'DEVNET'} RPC:`, rpcInUse?.substring(0, 50) + '...');

    // Test Telegram configuration if provided
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
        console.log("📱 Testing Telegram configuration...");
        const telegramTest = await validateTelegramConfig(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
        if (!telegramTest.valid) {
            console.warn(`⚠️  Telegram validation failed: ${telegramTest.error}`);
            console.warn("📱 Continuing without Telegram notifications.");
        } else {
            console.log("✅ Telegram configuration valid");
        }
    }

    const config = loadBotConfig();
    const wallet = loadWallet();
    if (wallet) {
        console.log("🔑 Wallet address:", getWalletAddress(wallet));
    } else {
        console.log("⚠️ Monitor-only mode (no PRIVATE_KEY); skipping any buy/sell operations.");
    }

    startTelegramBot();
    pendingTokens.clear();

    console.log("🚀 Bot started!");
    
    // Get RPC info from active connection
    try {
        const currentConnection = getConnection();
        const version = await currentConnection.getVersion();
        console.log("🌐 RPC connected:", version);
        
        const currentRpc = rpcManager.getCurrentRpcStatus();
        if (currentRpc) {
            console.log("🔌 Using RPC:", currentRpc.endpoint.url.substring(0, 50) + '...');
            const internalConn = currentConnection as any;
            const wsUrl = internalConn._rpcWebSocket?._url ?? "(WebSocket not connected)";
            console.log("🔌 Using WebSocket:", wsUrl);
        } else {
            console.log("🔌 Using RPC:", RPC_URL);
            const internalConn = connection as any;
            const wsUrl = internalConn._rpcWebSocket?._url ?? "(WebSocket not connected)";
            console.log("🔌 Using WebSocket:", wsUrl);
        }
    } catch (error) {
        // Fallback to legacy connection info
        console.log("🌐 RPC connected:", await connection.getVersion());
        console.log("🔌 Using RPC:", RPC_URL);
    }

    // Initialize position persistence system
    console.log("💾 Initializing position persistence...");
    try {
        await positionPersistence.initialize();
        console.log("✅ Position persistence initialized");
        
        // Reconcile positions with actual wallet state if wallet available
        if (wallet) {
            console.log("🔍 Reconciling positions with wallet state...");
            const currentConnection = getConnection();
            const reconciliation = await positionPersistence.reconcilePositions(currentConnection, wallet.publicKey);
            
            console.log(`📊 Position reconciliation: ${reconciliation.positionsRestored} restored, ${reconciliation.positionsRemoved} removed, ${reconciliation.exposureAdjustments} adjusted`);
            
            if (reconciliation.warnings.length > 0) {
                console.log("⚠️ Reconciliation warnings:", reconciliation.warnings.slice(0, 3));
            }
            if (reconciliation.errors.length > 0) {
                console.log("❌ Reconciliation errors:", reconciliation.errors.slice(0, 3));
            }
        }
        
        // Restore portfolio risk state
        await portfolioRiskManager.restoreFromPersistence();
        console.log("✅ Portfolio risk state restored");
        
    } catch (error) {
        console.warn("⚠️ Position persistence initialization failed, continuing without persistence", (error as Error).message);
    }

    await initAutoSellConfig();
    configureAutoSell(config.autoSellDelaySeconds ?? 90, config.dryRun);
    
    // Restore auto-sell positions
    try {
        await restorePositionsFromPersistence();
        console.log("✅ Auto-sell positions restored");
    } catch (error) {
        console.warn("⚠️ Failed to restore auto-sell positions", (error as Error).message);
    }
    
    void runAutoSellLoop();
    console.log("✅ Auto-sell loop started");

    // Initialize metrics collection and HTTP server
    console.log("📊 Initializing metrics collection...");
    try {
        await metricsCollector.initialize();
        console.log("✅ Metrics collector initialized");
        
        // Start metrics HTTP server
        await metricsServer.start();
        const serverStatus = metricsServer.getStatus();
        console.log(`📈 Metrics server started on http://${serverStatus.config.host}:${serverStatus.config.port}${serverStatus.config.endpoint}`);
        
    } catch (error) {
        console.warn("⚠️ Metrics initialization failed, continuing without metrics", (error as Error).message);
    }

    // 🚨 Push into pending queue instead of processing instantly, with normalization
    await monitorPumpPortal((token) => {
        const norm = normalizeMint(token.mint, token.pool);
        if (!norm) return;
        if (!pendingTokens.has(norm)) {
            pendingTokens.set(norm, { ...token, mint: norm });
            console.log("🟢 Queued new token for validation:", norm);
        }
    });


    // ✅ Start retry validator for deferred processing
    await startRetryValidator(handleValidatedToken);
}

async function handleValidatedToken(token: PumpToken) {
    const config = loadBotConfig();
    const wallet = loadWallet();
    if (!wallet) return;

    try {
        logger.info('BOT', 'Processing validated token', { 
            mint: token.mint.substring(0, 8) + '...', 
            pool: token.pool 
        });

        // Record token validation start
        const safetyCheckStart = Date.now();
        metricsCollector.recordTokenValidation('safety_check', 'start');

        const result = await checkTokenSafety(token, config, connection, wallet.publicKey);
        const safetyCheckDuration = Date.now() - safetyCheckStart;
        
        if (!result.passed) {
            logger.info('BOT', 'Token failed safety checks', { 
                mint: token.mint.substring(0, 8) + '...', 
                reason: result.reason 
            });
            metricsCollector.recordTokenValidation('safety_check', 'fail');
            metricsCollector.recordTradingOperation('safety_check', 'failure', safetyCheckDuration, result.reason || 'unknown');
            return;
        }
        
        metricsCollector.recordTokenValidation('safety_check', 'pass');
        metricsCollector.recordTradingOperation('safety_check', 'success', safetyCheckDuration);

        // Record scoring phase
        const scoringStart = Date.now();
        const { score, details } = await scoreToken(token);
        const scoringDuration = Date.now() - scoringStart;
        
        logger.info('BOT', 'Token scored', { 
            mint: token.mint.substring(0, 8) + '...', 
            score, 
            threshold: config.scoreThreshold, 
            details 
        });

        metricsCollector.recordTradingOperation('scoring', 'success', scoringDuration);
        metricsCollector.recordTokenScore(score, config.scoreThreshold);

        if (score < config.scoreThreshold) {
            logger.info('BOT', 'Score below threshold - skipping', { 
                mint: token.mint.substring(0, 8) + '...', 
                score, 
                threshold: config.scoreThreshold 
            });
            metricsCollector.recordTokenValidation('scoring', 'fail');
            return;
        }
        
        metricsCollector.recordTokenValidation('scoring', 'pass');

        const buyAmount = config.buyAmounts[String(score)] ?? 0.1;

        if (recentlyQuoted.has(token.mint)) {
            console.log(`⏭️ Already simulated ${token.mint}, skipping duplicate.`);
            return;
        }
        recentlyQuoted.add(token.mint);
        setTimeout(() => recentlyQuoted.delete(token.mint), 10 * 60 * 1000);

        await sleep(50 + Math.random() * 50);

        if ((jupiterQueue as any)._queue?.length > 10) {
            console.log(`🚦 Quote queue too long — skipping ${token.mint}`);
            return;
        }

        if (recentQuotes.length > 10) {
            console.log(`⛔ Quote limit hit — delaying`);
            await sleep(1500);
            recentQuotes = [];
        }
        recentQuotes.push(token.mint);

        let currentPrice: number | null = null;
        try {
            // Record Jupiter quote phase
            const quoteStart = Date.now();

            // Add a retry loop to allow liquidity to form
            let priceResult = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) {
                    console.log(`🔁 Retry Jupiter quote for ${token.mint} (attempt ${attempt + 1})...`);
                    await sleep(5000); // Wait 5 seconds before retrying
                }

                try {
                    await sleep(100 + Math.random() * 250);
                    priceResult = await getCurrentPriceViaJupiter(token.mint, buyAmount, wallet);
                    if (priceResult) break;
                } catch (err) {
                    if (err instanceof Error) {
                        console.warn(`⚠️ Jupiter quote attempt ${attempt + 1} failed:`, err.message);
                    } else {
                        console.warn(`⚠️ Jupiter quote attempt ${attempt + 1} failed:`, err);
                    }

                }
            }

            const quoteDuration = Date.now() - quoteStart;

            if (!priceResult) {
                console.log(`❌ Failed to simulate price for ${token.mint} — skipping`);
                metricsCollector.recordTradingOperation('quote', 'failure', quoteDuration, 'no_route');
                return;
            }
            
            metricsCollector.recordTradingOperation('quote', 'success', quoteDuration);
            currentPrice = priceResult.price;
        } catch (err: any) {
            console.log(`⚠️ Skipping Jupiter quote for ${token.mint}: ${err.message || err}`);
            return;
        }

        console.log(`🚀 Safety & score passed; sniping ${token.mint} for ${buyAmount} SOL`);
        
        // Record trade execution
        const tradeStart = Date.now();
        await trySnipeToken(connection, wallet, token.mint, buyAmount, config.dryRun, token.creator);
        const tradeDuration = Date.now() - tradeStart;
        
        // Note: Trade success/failure is recorded within snipeToken function
        metricsCollector.recordTradingOperation('buy', 'success', tradeDuration);

        await sendTelegramMessage(
            `🎯 *Sniped token* \`${token.mint}\`\n` +
            `📊 Score: ${score}/7\n` +
            `💸 Buy: ${buyAmount} SOL @ ${currentPrice?.toFixed(4)} SOL/token\n` +
            `🔗 [Pump](https://pump.fun/${token.mint})`
        );

        try {
            trackBuy(token.mint, buyAmount, currentPrice, token.creator);
        } catch (err) {
            console.error(`❌ Failed to track buy for ${token.mint}:`, err);
        }
    } catch (err: any) {
        logger.error('BOT', 'Critical error in token validation handler', {
            mint: token.mint?.substring(0, 8) + '...' || 'unknown',
            pool: token.pool
        }, err);
        
        // Record token processing failure
        metricsCollector.recordTokenValidation('processing', 'error');
        metricsCollector.recordSystemEvent('error', 'token_validation_handler', err.message || 'unknown');
        
        // If we're getting repeated errors, we might want to implement
        // circuit breaker logic here in the future
        logger.recordFailure('TOKEN_HANDLER');
    }
}

async function trySnipeToken(
    connection: Connection,
    wallet: Keypair,
    mint: string,
    amount: number,
    dryRun: boolean,
    deployer?: string
) {
    const now = Date.now();

    if (!dryRun) {
        if (now - lastSnipeTime < SNIPE_COOLDOWN_MS) {
            console.log(`⏳ Cooldown active, skipping ${mint}`);
            return;
        }

        if (totalBuys >= MAX_BUYS) {
            console.log(`🚫 Max buy limit reached, skipping ${mint}`);
            return;
        }

        lastSnipeTime = now;
        totalBuys++;
    }

    await snipeToken({ connection, wallet, mint, amountSOL: amount, dryRun, deployer });
}

async function runWithRestart() {
    let restartCount = 0;
    const maxRestarts = 5;
    
    while (restartCount < maxRestarts) {
        try {
            await main();
            break; // If main() completes without error, exit the loop
        } catch (err: any) {
            restartCount++;
            console.error(`❌ Bot crashed with error (attempt ${restartCount}/${maxRestarts}):`, err);
            console.error("🔍 Details:", JSON.stringify(err, null, 2));
            
            // Log the restart attempt
            logger.error('BOT_RESTART', `Bot crashed and restarting (${restartCount}/${maxRestarts})`, {
                restartCount,
                maxRestarts
            }, err);
            
            if (restartCount < maxRestarts) {
                const delay = Math.min(5000 * restartCount, 30000); // Exponential backoff, max 30s
                console.log(`🔄 Restarting in ${delay/1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error("💥 Max restart attempts reached. Bot shutting down.");
                logger.error('BOT_SHUTDOWN', 'Max restart attempts reached - bot shutting down', {
                    restartCount,
                    maxRestarts
                });
                process.exit(1);
            }
        }
    }
}

runWithRestart();
