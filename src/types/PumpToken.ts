// src/types/PumpToken.ts

export interface PumpToken {
    rawData?: any;
    mint: string;
    pool: string;
    signature?: string;
    creator: string;
    timestamp?: number;      // Alternative to launchedAt
    launchedAt?: number;
    discoveredAt?: number;   // When token was first discovered by the bot
    simulatedLp: number;
    hasJupiterRoute: boolean;
    lpTokenAddress: string;
    metadata: {
        name: string;
        symbol: string;
        decimals: number;
        description?: string;  // Token description for social verification
        uri?: string;          // Metadata URI for additional token info
        image?: string;        // Token image URL
    };
    earlyHolders: number;
    launchSpeedSeconds: number;
}
