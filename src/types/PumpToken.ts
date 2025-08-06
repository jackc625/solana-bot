// src/types/PumpToken.ts

export interface PumpToken {
    rawData?: any;
    mint: string;
    pool: string;
    signature: string;
    creator: string;
    launchedAt: number;
    simulatedLp: number;
    hasJupiterRoute: boolean;
    lpTokenAddress: string;
    metadata: {
        name: string;
        symbol: string;
        decimals: number;
    };
    earlyHolders: number;
    launchSpeedSeconds: number;
}
