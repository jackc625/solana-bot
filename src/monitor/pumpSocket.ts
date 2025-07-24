// src/monitor/pumpSocket.ts

import WebSocket from "ws";
import { PublicKey } from "@solana/web3.js";
import { PumpToken } from "./pumpFun.js";
import { pendingTokens } from "../state/pendingTokens.js"; // 👈 we’ll create this next

const seenMints = new Set<string>();
const recentLaunches: string[] = [];
const solMint = new PublicKey("So11111111111111111111111111111111111111112");

// reset per-minute counter
setInterval(() => (recentLaunches.length = 0), 60_000);

export const monitorPumpSocket = async (
    onNewToken: (token: PumpToken) => void,
) => {
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
            console.warn("⚠️ Non‑JSON WS message:", raw.toString());
            return;
        }

        if (msg.message && typeof msg.message === "string") {
            console.log("📬 PumpPortal says:", msg.message);
            return;
        }

        const mint: string | undefined =
            typeof msg.mint === "string"
                ? msg.mint
                : typeof msg.tokenId === "string"
                    ? msg.tokenId
                    : msg.data?.tokenId;

        if (!mint || seenMints.has(mint)) return;
        seenMints.add(mint);

        if (recentLaunches.length >= 20) {
            console.log(`⏳ Dropping ${mint} — too many launches`);
            return;
        }
        recentLaunches.push(mint);

        await sleep(100 + Math.random() * 50);

        try {
            const token: PumpToken = {
                mint,
                creator: msg.creator ?? msg.data?.creator ?? "unknown",
                launchedAt: (msg.timestamp ?? msg.data?.timestamp ?? Date.now()) * 1000,
                simulatedLp: 0,
                hasJupiterRoute: false,
                lpTokenAddress: "",
                metadata: {
                    name: msg.name ?? msg.data?.name ?? "Unknown",
                    symbol: msg.symbol ?? msg.data?.symbol ?? "???",
                    decimals: 9,
                },
                earlyHolders: 0,
                launchSpeedSeconds: 0,
            };

            console.log("🟢 WS token detected:", token.mint);
            pendingTokens.set(mint, token); // 👈 saved for background validation
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
};

function sleep(ms: number) {
    return new Promise<void>((res) => setTimeout(res, ms));
}

