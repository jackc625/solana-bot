// src/config/index.ts

import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

export interface BotConfig {
    dryRun: boolean;
    minLiquidity: number;
    maxLiquidity: number;
    scoreThreshold: number;
    buyAmounts: Record<string, number>;
    tpMultiplier: number;
    slDropFromPeak: number;
    fallbackMinutes: number;
    slippage: number;
    autoSellDelaySeconds?: number;
    fallbackMs?: number; // calculated after load
    honeypotSellTaxThreshold?: number;
    maxTaxPercent: number;
    minHoldMs: number;
    maxHoldMs: number;
    checkIntervalMs: number;
    targetRoi: number;
    stopLossRoi: number;
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
            minHoldMs: json.minHoldMs ?? 45000,
            maxHoldMs: json.maxHoldMs ?? 120000,
            checkIntervalMs: json.checkIntervalMs ?? 5000,
            targetRoi: json.targetRoi ?? 0.5,
            stopLossRoi: json.stopLossRoi ?? -0.25,
        };

        config.fallbackMs = config.fallbackMinutes * 60 * 1000;
        return config;
    } catch (err) {
        console.error("❌ Failed to load config:", err);
        throw err;
    }
};