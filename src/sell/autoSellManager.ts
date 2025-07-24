import { connection, loadWallet, getTokenBalance } from "../utils/solana.js";
import { sellToken, getCurrentPriceViaJupiter } from "../core/trading.js";
import { loadBotConfig } from "../config/index.js";
import { logTrade } from "../utils/logger.js";
import { simulateSell } from "../utils/jupiter.js";
import { PublicKey } from "@solana/web3.js";

type ActivePosition = {
    mint: string;
    amount: number;
    buyTime: number;
    buyPrice: number;
    creator?: string;
    creatorInitialBalance?: number;
};

let config: Awaited<ReturnType<typeof loadBotConfig>>;
let fallbackMs: number;

export async function initAutoSellConfig() {
    config = await loadBotConfig();
    fallbackMs = config.fallbackMs ?? 300_000;
}

const activePositions: ActivePosition[] = [];
const peakPriceMap: Record<string, number> = {};

let dryRun = true;

export function configureAutoSell(delaySeconds: number, isDry: boolean) {
    dryRun = isDry;
}

export async function trackBuy(mint: string, amount: number, buyPrice: number, creator?: string) {
    let creatorInitialBalance = 0;

    if (creator) {
        try {
            creatorInitialBalance = await getTokenBalance(new PublicKey(mint), new PublicKey(creator));
        } catch {
            creatorInitialBalance = 0;
        }
    }

    const pos: ActivePosition = {
        mint,
        amount,
        buyTime: Date.now(),
        buyPrice,
        creator,
        creatorInitialBalance,
    };

    activePositions.push(pos);
    peakPriceMap[mint] = buyPrice;

    console.log(`⏳ Tracking ${mint}: Buy @ ${buyPrice}`);
    startSellWatcher(pos);
}

export async function runAutoSellLoop() {
    const wallet = loadWallet();
    if (!wallet) {
        console.warn("⚠️ Monitor‑only mode: auto‑sell loop disabled (no wallet)");
        return;
    }

    setInterval(async () => {
        const now = Date.now();

        for (let i = activePositions.length - 1; i >= 0; i--) {
            const pos = activePositions[i];
            const { mint, buyTime, buyPrice, amount } = pos;

            const result = await getCurrentPriceViaJupiter(mint, amount, wallet);
            if (!result) {
                console.log(
                    `❌ Skipping auto-sell check for ${mint} — Jupiter price unavailable`
                );
                continue;
            }

            const { price: currentPrice } = result;

            if (currentPrice > (peakPriceMap[mint] || 0)) {
                peakPriceMap[mint] = currentPrice;
            }

            const peak = peakPriceMap[mint];
            const tpPrice = buyPrice * config.tpMultiplier;
            const slPrice = peak * (1 - config.slDropFromPeak);

            let reason =
                currentPrice >= tpPrice
                    ? "Take-Profit"
                    : currentPrice <= slPrice
                        ? "Stop-Loss"
                        : now - buyTime >= fallbackMs
                            ? "Fallback Timer"
                            : null;

            // Check for dev wallet dump
            if (pos.creator && pos.creatorInitialBalance && pos.creatorInitialBalance > 0) {
                try {
                    const devNow = await getTokenBalance(new PublicKey(mint), new PublicKey(pos.creator));
                    const dropRatio = 1 - devNow / pos.creatorInitialBalance;

                    if (dropRatio >= 0.5) {
                        reason = `Dev dumped ${Math.round(dropRatio * 100)}%`;
                    }
                } catch (err) {
                    console.warn(`⚠️  Failed to check dev dump: ${err}`);
                }
            }

            if (reason) {
                console.log(
                    `💰 ${dryRun ? "[DRY]" : "[SELL]"} ${mint} - ${reason} triggered at ${currentPrice.toFixed(
                        4
                    )}`
                );

                if (!dryRun) {
                    await sellToken(connection, wallet, mint, amount, dryRun);

                    await logTrade({
                        type: "SELL",
                        token: mint,
                        reason,
                        amount,
                        price: currentPrice,
                        peak,
                        dryRun,
                    });
                }

                activePositions.splice(i, 1);
                delete peakPriceMap[mint];
            }
        }
    }, 5000);
}

export async function startSellWatcher(pos: ActivePosition) {
    const wallet = loadWallet();
    if (!wallet) {
        console.warn("⚠️ Monitor‑only mode: sell watcher disabled (no wallet)");
        return;
    }

    const { mint, amount, buyTime, buyPrice } = pos;
    const entryPrice = buyPrice;
    const start = Date.now();

    const checkInterval = setInterval(async () => {
        const now = Date.now();
        const elapsed = now - start;

        if (elapsed < config.minHoldMs) return;

        const result = await simulateSell({
            tokenMint: mint,
            tokenAmount: amount,
            userPubkey: wallet.publicKey
        });

        if (!result.success) {
            console.warn(`❌ [${mint}] Sell simulation failed — token may be unsellable`);
            clearInterval(checkInterval);
            return;
        }

        const currentPrice = result.expectedOut / amount;

        const roi = (currentPrice - entryPrice) / entryPrice;

        console.log(`📈 [${mint}] ROI: ${(roi * 100).toFixed(2)}%`);

        let devDumpDetected = false;

        if (pos.creator && pos.creatorInitialBalance && pos.creatorInitialBalance > 0) {
            try {
                const devNow = await getTokenBalance(new PublicKey(mint), new PublicKey(pos.creator));
                const dropRatio = 1 - devNow / pos.creatorInitialBalance;

                if (dropRatio >= 0.5) {
                    devDumpDetected = true;
                    console.warn(`🚨 [${mint}] Dev dumped ${Math.round(dropRatio * 100)}% of tokens`);
                }
            } catch (err) {
                console.warn(`⚠️  [${mint}] Dev dump check failed: ${err}`);
            }
        }

        const shouldSell =
            roi >= config.targetRoi ||
            roi <= config.stopLossRoi ||
            elapsed >= config.maxHoldMs ||
            devDumpDetected;

        const reason =
            roi >= config.targetRoi
                ? "ROI Target"
                : roi <= config.stopLossRoi
                    ? "ROI Stop-Loss"
                    : elapsed >= config.maxHoldMs
                        ? "Max Hold Time"
                        : devDumpDetected
                            ? "Dev Dump Detected"
                            : null;

        if (shouldSell && reason) {
            clearInterval(checkInterval);

            console.log(
                `🚨 [${dryRun ? "DRY" : "SELL"}] ${mint} - ${reason} @ ${currentPrice.toFixed(4)}`
            );

            if (!dryRun) {
                await sellToken(connection, wallet, mint, amount, dryRun);
                await logTrade({
                    type: "SELL",
                    token: mint,
                    reason,
                    amount,
                    price: currentPrice,
                    peak: currentPrice,
                    dryRun,
                });
            }

            // cleanup
            const index = activePositions.findIndex(p => p.mint === mint);
            if (index !== -1) activePositions.splice(index, 1);
            delete peakPriceMap[mint];
        }
    }, config.checkIntervalMs);
}
