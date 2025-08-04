// src/core/scoring.ts

import { PumpToken } from "../monitor/pumpFun.js";
import { PublicKey } from "@solana/web3.js"
import { connection } from "../utils/solana.js";

export interface ScoreResult {
    score: number;
    details: {
        metadata: boolean;
        earlyHolders: boolean;
        launchSpeed: boolean;
        cleanDeployer: boolean;
        hasSocial: boolean;
        largeCap: boolean;
        deployerWhale: boolean;
    };
}

function estimateMarketCap(token: PumpToken): number {
    const liquidity = token.simulatedLp || 0;
    const pricePerToken = liquidity > 0 ? 2 / liquidity : 0; // rough estimation
    const supply = Math.pow(10, token.metadata.decimals || 9); // assume 1B tokens if unknown

    return supply * pricePerToken;
}

async function fetchDeployerHistory(creator: string): Promise<number> {
    try {
        const res = await fetch("https://pump.fun/api/runners");
        const data = await res.json();

        const recentCount = data.filter((entry: any) => {
            const coin = entry.coin;
            return coin && coin.creator === creator;
        }).length;

        return recentCount;
    } catch (err) {
        console.error("⚠️ Failed to fetch deployer history:", err);
        return 0;
    }
}

export const scoreToken = async (token: PumpToken): Promise<ScoreResult> => {
    const recentTokensByDeployer = await fetchDeployerHistory(token.creator);
    const marketCap = estimateMarketCap(token);
    let deployerWhale = false;

    try {
        const mintPubkey = new PublicKey(token.mint);
        const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
        const topAccount = largestAccounts.value[0];
        const topAmount = topAccount?.uiAmount ?? 0;

        deployerWhale = topAmount >= 200_000_000; // 20% of 1B assumed total
    } catch (err) {
        console.warn(`⚠️ Failed to check largest token holder:`, err);
    }

    const details = {
        metadata: !!(token.metadata.name && token.metadata.symbol && token.metadata.decimals !== undefined),
        earlyHolders: token.earlyHolders >= 75,
        launchSpeed: token.launchSpeedSeconds <= 120,
        cleanDeployer: recentTokensByDeployer <= 3,
        hasSocial: !!token.rawData?.twitterHandle || !!token.rawData?.discordLink || !!token.rawData?.website,
        largeCap: marketCap >= 10_000, // estimated cap must be ≥ $10K
        deployerWhale: !deployerWhale
    };

    const score = Object.values(details).filter(Boolean).length;

    return { score, details };
};
