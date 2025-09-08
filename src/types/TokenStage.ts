// src/types/TokenStage.ts
// Stage-aware token processing types to fix the pre-bond/post-bond pipeline mix-up

export type TokenStage = 'PRE_BOND' | 'BONDED_ON_PUMP' | 'RAYDIUM_LISTED';

export interface TokenCandidate {
    mint: string;
    creator: string;
    pool: string;
    createdAt: number;
    discoveredAt: number;
    stage: TokenStage;
    
    // Stage-specific data
    preBondScore?: number;
    firstSeenBondedAt?: number;
    lastCheckedAt?: number;
    
    // Validation state
    attempts: number;
    maxAttempts: number;
    retryWindowMs: number;
    
    // Jupiter/liquidity data (only available after RAYDIUM_LISTED)
    hasJupiterRoute?: boolean;
    simulatedLp?: number;
    priceImpact?: number;
    
    // Failure tracking
    lastFailureReason?: string;
    failureReasons: string[];
}

export interface StageTransitionResult {
    success: boolean;
    newStage?: TokenStage;
    reason?: string;
    shouldDrop?: boolean;
    retryAfter?: number; // ms
}

export interface SafetyCheckConfig {
    // Stage-specific check configuration
    preBond: {
        enabled: boolean;
        minNameLength: number;
        maxNameLength: number;
        requireImage: boolean;
        checkCreatorHistory: boolean;
        minCreatorAge: number; // ms
        skipDeadHours: boolean;
    };
    bondedOnPump: {
        enabled: boolean;
        maxWaitTimeMs: number;
        minVelocityChecks: number;
        trackUniqueWallets: boolean;
        creatorBehaviorCheck: boolean;
    };
    raydiumListed: {
        enabled: boolean;
        minLiquidity: number;
        maxLiquidity?: number;
        honeypotCheck: boolean;
        lpLockCheck: boolean;
        socialVerificationCheck: boolean;
        holderDistributionCheck: boolean;
        mintAuthorityCheck: boolean;
    };
}

export const DEFAULT_STAGE_CONFIG: SafetyCheckConfig = {
    preBond: {
        enabled: true,
        minNameLength: 3,
        maxNameLength: 50,
        requireImage: true,
        checkCreatorHistory: true,
        minCreatorAge: 30 * 60 * 1000, // 30 minutes
        skipDeadHours: true,
    },
    bondedOnPump: {
        enabled: true,
        maxWaitTimeMs: 5 * 60 * 1000, // 5 minutes
        minVelocityChecks: 3,
        trackUniqueWallets: true,
        creatorBehaviorCheck: true,
    },
    raydiumListed: {
        enabled: true,
        minLiquidity: 10, // SOL
        maxLiquidity: undefined,
        honeypotCheck: true,
        lpLockCheck: true,
        socialVerificationCheck: true,
        holderDistributionCheck: true,
        mintAuthorityCheck: true,
    },
};

// Pool detection backoff configuration
export const POOL_DETECTION_CONFIG = {
    backoffDelaysMs: [2000, 3000, 5000, 8000, 13000], // Exponential backoff
    maxPoolDetectionTime: 5 * 60 * 1000, // 5 minutes max wait
    poolCheckIntervalMs: 2000, // How often to check for new pools
};

// Failure reason categories for metrics and debugging
export const FAILURE_REASONS = {
    // Pre-bond failures
    INVALID_NAME: 'invalid_name',
    NO_IMAGE: 'no_image',
    CREATOR_TOO_NEW: 'creator_too_new',
    CREATOR_BLACKLISTED: 'creator_blacklisted',
    DEAD_HOURS: 'dead_hours',
    LOW_PREBOND_SCORE: 'low_prebond_score',
    
    // Bonded phase failures  
    NO_POOL_TIMEOUT: 'no_pool_timeout',
    LOW_VELOCITY: 'low_velocity',
    SUSPICIOUS_CREATOR: 'suspicious_creator',
    
    // Raydium phase failures
    NO_ROUTE: 'no_route',
    LOW_LIQUIDITY: 'low_liquidity',
    HIGH_LIQUIDITY: 'high_liquidity',
    HONEYPOT: 'honeypot',
    NO_LP_LOCK: 'no_lp_lock',
    LOW_SOCIAL_SCORE: 'low_social_score',
    BAD_HOLDER_DISTRIBUTION: 'bad_holder_distribution',
    DANGEROUS_AUTHORITIES: 'dangerous_authorities',
    HIGH_SLIPPAGE: 'high_slippage',
    
    // System failures
    RPC_ERROR: 'rpc_error',
    TIMEOUT: 'timeout',
    UNKNOWN_ERROR: 'unknown_error',
} as const;

export type FailureReason = typeof FAILURE_REASONS[keyof typeof FAILURE_REASONS];