// src/monitor/dexScreener.ts

import fetch from "node-fetch";

const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const seenPairs: Record<string, number> = {};

export const monitorDexScreener = async (onNewPair: (pair: any) => void) => {
    const poll = async () => {
        try {
            const res = await fetch("https://api.dexscreener.com/latest/dex/pairs", {
                headers: {
                    "User-Agent": "Mozilla/5.0", // prevents 403 or HTML response
                },
            });

            const raw = await res.text();
            const data = JSON.parse(raw);

            const solanaPairs = data.pairs.filter((p: any) => p.chainId === "solana");

            const now = Date.now();
            for (const pair of solanaPairs) {
                const lastSeen = seenPairs[pair.pairAddress];
                if (!lastSeen || now - lastSeen > SEEN_TTL_MS) {
                    seenPairs[pair.pairAddress] = now;
                    console.log("🟢 New Solana pair:", pair.baseToken.symbol, pair.pairAddress);
                    onNewPair(pair);
                }
            }
        } catch (err) {
            console.error("❌ Error polling Dexscreener:", err);
        }

        setTimeout(poll, 10_000); // 10 second interval
    };

    // 🧹 Cleanup expired entries every 60 seconds
    setInterval(() => {
        const now = Date.now();
        for (const key in seenPairs) {
            if (now - seenPairs[key] > SEEN_TTL_MS) {
                delete seenPairs[key];
            }
        }
    }, 60_000);

    poll();
};
