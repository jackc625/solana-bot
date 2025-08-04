// src/monitor/pumpSocket.ts

import WebSocket from "ws";
import { PublicKey } from "@solana/web3.js";
import { PumpToken } from "./pumpFun.js";
import { normalizeMint } from "../utils/normalizeMint.js";
import { getJupiter } from "../utils/jupiterInstance.js";
import {getLpLiquidityDirectly, getLpLiquidityFromPump} from "../utils/getLpLiquidity.js";
import { getLpTokenAddress } from "../utils/getLpTokenAddress.js";
import { hasDirectJupiterRoute } from "../utils/hasDirectJupiterRoute.js";

const seenMints: Record<string, number> = {};
const SEEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

const recentLaunches: string[] = [];
setInterval(() => (recentLaunches.length = 0), 60_000);

const solMint = new PublicKey("So11111111111111111111111111111111111111112");

export const monitorPumpSocket = async (
    onNewToken: (token: PumpToken) => void,
) => {
    const jupiter = await getJupiter();
    if (!jupiter) {
        console.error("❌ Jupiter instance failed to load.");
        return;
    }

    const socket = new WebSocket("wss://pumpportal.fun/api/data");

    socket.on("open", () => {
        console.log("✅ Connected to PumpPortal WebSocket");
        socket.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    socket.on("message", async (raw) => {
        let msg: any;
        try {
            msg = JSON.parse(raw.toString());
        } catch (err) {
            console.warn("⚠️ Non-JSON WS message:", raw.toString());
            return;
        }

        if (msg.message && typeof msg.message === "string") {
            console.log("📬 PumpPortal says:", msg.message);
            return;
        }

        const rawMint =
            typeof msg.mint === "string"
                ? msg.mint
                : typeof msg.tokenId === "string"
                    ? msg.tokenId
                    : msg.data?.tokenId;

        const mint = normalizeMint(rawMint ?? "");
        if (!mint) {
            console.warn(`⚠️ Could not normalize mint from raw: ${rawMint}`, "Raw message:", msg);
            return;
        }

        const now = Date.now();
        if (seenMints[mint] && now - seenMints[mint] < SEEN_TTL_MS) return;
        seenMints[mint] = now;

        console.log("🧪 Cleaned Mint:", mint, "| Raw:", rawMint);

        if (recentLaunches.length >= 20) {
            console.log(`⏳ Dropping ${mint} — too many launches`);
            return;
        }
        recentLaunches.push(mint);

        await sleep(100 + Math.random() * 50); // Slight delay before enrichment

        try {
            const tokenMint = new PublicKey(mint);
            const liquidity = await getLpLiquidityDirectly(mint);
            const lpSol = liquidity?.lpSol ?? 0;
            const earlyHolders = liquidity?.earlyHolders ?? 0;

            const lpTokenAddress = await getLpTokenAddress(jupiter, solMint, tokenMint);
            const hasJupiterRoute = await hasDirectJupiterRoute(jupiter, solMint, tokenMint);

            const ts = Math.floor(msg.timestamp ?? msg.data?.timestamp ?? Date.now());
            const launchedAt = isNaN(ts) ? Math.floor(Date.now()) : ts;

            const token: PumpToken = {
                mint,
                creator: msg.creator ?? msg.data?.creator ?? "unknown",
                launchedAt,
                simulatedLp: lpSol,
                hasJupiterRoute,
                lpTokenAddress,
                metadata: {
                    name: msg.name ?? msg.data?.name ?? "Unknown",
                    symbol: msg.symbol ?? msg.data?.symbol ?? "???",
                    decimals: 9,
                },
                earlyHolders,
                launchSpeedSeconds: 0,
            };

            console.log("🟢 WS token detected:", token.mint);
            console.log("🧪 Token debug:", {
                lpSol,
                earlyHolders,
                lpTokenAddress,
                hasJupiterRoute,
            });

            onNewToken(token);
        } catch (err) {
            console.warn("⚠️ Error processing token event:", err);
        }
    });

    socket.on("error", (err) => {
        console.error("❌ WebSocket error:", err);
    });

    socket.on("close", (code, reason) => {
        console.warn(`⚠️ WebSocket closed (${code}):`, reason.toString());
    });

    // Cleanup seen mints to avoid memory leaks
    setInterval(() => {
        const now = Date.now();
        for (const mint in seenMints) {
            if (now - seenMints[mint] > SEEN_TTL_MS) {
                delete seenMints[mint];
            }
        }
    }, 60_000);
};

function sleep(ms: number) {
    return new Promise<void>((res) => setTimeout(res, ms));
}
