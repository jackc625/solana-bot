// src/config/index.ts

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

export interface RpcEndpoint {
    url: string;
    name: string;
    priority: number;
    maxRetries?: number;
    timeoutMs?: number;
    wsUrl?: string;
}

export interface MEVProtectionConfig {
    enabled: boolean;
    protectionLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'AGGRESSIVE';
    customTipAmount?: number;
    maxBundleSize: number;
    timeoutMs: number;
    retryAttempts: number;
    blockEngineUrl?: string;
    maxFeeMultiplier?: number;
    maxBundleTip?: number;
    emergencyDisable?: boolean;
    riskThresholds?: {
        abortOnCritical?: boolean;
        maxTradeDelayMs?: number;
        forcePrivateMempoolAbove?: number;
    };
    sandwichDetection?: {
        enabled?: boolean;
        sensitivity?: 'LOW' | 'MEDIUM' | 'HIGH';
        mempoolAnalysisDepth?: number;
        patternHistoryMs?: number;
    };
}

export interface BotConfig {
    dryRun: boolean;
    minLiquidity: number;
    maxLiquidity: number;
    scoreThreshold: number;
    
    // Multi-RPC configuration
    rpcEndpoints?: RpcEndpoint[];
    
    // Stage-aware pipeline configuration
    stageAwarePipeline?: {
        enabled?: boolean;
        debugMode?: boolean;
        maxConcurrentTokens?: number;
        metricsLoggingIntervalMs?: number;
        watchlistStatsIntervalMs?: number;
        preBond?: any;
        bondedOnPump?: any;
        raydiumListed?: any;
    };
    rpcHealthCheckIntervalMs?: number;
    rpcFailoverThreshold?: number;
    buyAmounts: Record<string, number>;
    tpMultiplier: number;
    slDropFromPeak: number;
    fallbackMinutes: number;
    slippage: number;
    autoSellDelaySeconds?: number;
    fallbackMs?: number; // calculated after load
    honeypotSellTaxThreshold?: number;
    maxTaxPercent: number;
    honeypotCheck?: boolean;
    enhancedHoneypotDetection?: boolean;
    honeypotTestAmounts?: number[];
    
    // LP lock verification settings
    lpLockCheck?: boolean;
    lpLockMinPercentage?: number;
    lpLockMinDurationHours?: number;
    acceptBurnedLp?: boolean;
    acceptVestingLock?: boolean;
    minHoldMs: number;
    maxHoldMs: number;
    checkIntervalMs: number;
    targetRoi: number;
    stopLossRoi: number;
    priorityFee?: number;
    pool?: string;
    // Auto-sell manager specific fields
    takeProfitRoi?: number;
    dropFromPeakRoi?: number;
    postSellCooldownMs?: number;
    autoSellPollMs?: number;
    scaleOut?: Array<{roi: number; fraction: number}>;
    trailing?: Array<{threshold: number; drop: number}>;
    
    // Position size and risk management
    maxPositionSize?: number;        // Maximum SOL per position
    maxPositionsCount?: number;      // Maximum concurrent positions
    maxPortfolioPercent?: number;    // Maximum % of wallet balance to use
    maxWalletExposure?: number;      // Maximum total SOL exposure
    dailyLossLimit?: number;         // Maximum daily loss in SOL
    maxLossPercent?: number;         // Maximum % loss of wallet balance
    
    // Social verification settings
    socialVerificationCheck?: boolean;  // Enable social verification
    minSocialScore?: number;            // Minimum social score (0-10)
    requireSocialPresence?: boolean;    // Require social media presence
    blockBlacklistedTokens?: boolean;   // Block tokens on blacklist
    
    // Portfolio-level risk controls
    maxDeployerExposure?: number;       // Maximum SOL exposure per deployer
    maxTokenConcentration?: number;     // Maximum % of portfolio per token
    maxDeployerTokens?: number;         // Maximum tokens per deployer
    deployerCooldownMs?: number;        // Cooldown between trades from same deployer
    concentrationThreshold?: number;    // Warning threshold for concentration
    
    // MEV Protection settings
    mevProtection?: MEVProtectionConfig;
    
    // Dual Execution Strategy settings
    dualExecution?: {
        enabled?: boolean;
        defaultStrategy?: string;
        highRiskStrategy?: string;
        lowRiskStrategy?: string;
        jitoTimeoutMs?: number;
        publicTimeoutMs?: number;
        parallelTimeoutMs?: number;
        maxRetries?: number;
        fallbackDelayMs?: number;
        priorityFeeMultiplier?: number;
        emergencyPublicFallback?: boolean;
        strategySelection?: {
            autoSelectByRisk?: boolean;
            forceJitoAboveAmount?: number;
            forceParallelBelowAmount?: number;
            riskThresholds?: {
                highRisk?: number;
                mediumRisk?: number;
                lowRisk?: number;
            };
        };
        monitoring?: {
            logExecutionDetails?: boolean;
            trackSuccessRates?: boolean;
            alertOnFailures?: boolean;
            performanceMetrics?: boolean;
        };
    };
}

export const loadBotConfig = (): BotConfig => {
    try {
        const configPath = path.resolve(
            fileURLToPath(new URL(".", import.meta.url)),
            "../config/botConfig.json"
        );

        if (!fs.existsSync(configPath)) {
            throw new Error("❌ botConfig.json not found!");
        }

        const configRaw = fs.readFileSync(configPath, "utf-8");
        const json = JSON.parse(configRaw);

        const config: BotConfig = {
            dryRun: json.dryRun ?? true,
            minLiquidity: json.minLiquidity ?? 1,
            maxLiquidity: json.maxLiquidity ?? 100,
            scoreThreshold: json.scoreThreshold ?? 5,
            buyAmounts: json.buyAmounts ?? {},
            tpMultiplier: json.tpMultiplier ?? 2.0,
            slDropFromPeak: json.slDropFromPeak ?? 0.5,
            fallbackMinutes: json.fallbackMinutes ?? 5,
            slippage: json.slippage ?? 1,
            autoSellDelaySeconds: json.autoSellDelaySeconds ?? 90,
            honeypotSellTaxThreshold: json.honeypotSellTaxThreshold ?? 95,
            maxTaxPercent: json.maxTaxPercent ?? 10,
            honeypotCheck: json.honeypotCheck ?? true,
            enhancedHoneypotDetection: json.enhancedHoneypotDetection ?? true,
            honeypotTestAmounts: Array.isArray(json.honeypotTestAmounts) ? json.honeypotTestAmounts : [0.001, 0.01, 0.1],
            
            // LP lock verification settings
            lpLockCheck: json.lpLockCheck ?? true,
            lpLockMinPercentage: json.lpLockMinPercentage ?? 80,
            lpLockMinDurationHours: json.lpLockMinDurationHours ?? 24,
            acceptBurnedLp: json.acceptBurnedLp ?? true,
            acceptVestingLock: json.acceptVestingLock ?? true,
            minHoldMs: json.minHoldMs ?? 45000,
            maxHoldMs: json.maxHoldMs ?? 120000,
            checkIntervalMs: json.checkIntervalMs ?? 5000,
            targetRoi: json.targetRoi ?? 0.5,
            stopLossRoi: json.stopLossRoi ?? -0.25,
            priorityFee: json.priorityFee ?? 0.00001,
            pool: json.pool ?? "auto",
            // Auto-sell manager fields with proper fallbacks
            takeProfitRoi: json.takeProfitRoi ?? json.targetRoi ?? 0.2,
            dropFromPeakRoi: json.dropFromPeakRoi ?? json.slDropFromPeak ?? 0.25,
            postSellCooldownMs: json.postSellCooldownMs ?? 1500,
            autoSellPollMs: json.autoSellPollMs ?? 2000,
            scaleOut: Array.isArray(json.scaleOut) ? json.scaleOut : [],
            trailing: Array.isArray(json.trailing) ? json.trailing : [],
            
            // Social verification settings
            socialVerificationCheck: json.socialVerificationCheck ?? true,
            minSocialScore: json.minSocialScore ?? 2,
            requireSocialPresence: json.requireSocialPresence ?? false,
            blockBlacklistedTokens: json.blockBlacklistedTokens ?? true,
            
            // Portfolio-level risk controls
            maxDeployerExposure: json.maxDeployerExposure ?? 0.1,  // 0.1 SOL max per deployer
            maxTokenConcentration: json.maxTokenConcentration ?? 0.25, // 25% max per token
            maxDeployerTokens: json.maxDeployerTokens ?? 3,         // Max 3 tokens per deployer
            deployerCooldownMs: json.deployerCooldownMs ?? 300000,  // 5min cooldown per deployer
            concentrationThreshold: json.concentrationThreshold ?? 0.15, // Warn at 15% concentration
            
            // Multi-RPC configuration
            rpcEndpoints: Array.isArray(json.rpcEndpoints) ? json.rpcEndpoints : [],
            rpcHealthCheckIntervalMs: json.rpcHealthCheckIntervalMs ?? 30000,
            rpcFailoverThreshold: json.rpcFailoverThreshold ?? 3,
        };

        config.fallbackMs = config.fallbackMinutes * 60 * 1000;
        return config;
    } catch (err) {
        console.error("❌ Failed to load config:", err);
        throw err;
    }
};