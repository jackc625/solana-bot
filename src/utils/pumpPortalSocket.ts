// src/utils/pumpPortalSocket.ts

import WebSocket from "ws";
import { Buffer } from "buffer";
import { pendingTokens } from "../state/pendingTokens.js";
import { PumpToken } from "../types/PumpToken.js";
import { normalizeMint } from "./normalizeMint.js";
import {recordLaunch} from "../state/deployerHistory.js";

const SOCKET_URL = "wss://pumpportal.fun/api/data";
const SEEN_TTL_MS = 10 * 60 * 1000;

let socket: WebSocket | null = null;
let isConnected = false;
const seenMints: Record<string, number> = {};

export async function monitorPumpPortal(onNewToken: (token: PumpToken) => void): Promise<void> {
    socket = new WebSocket(SOCKET_URL);

    socket.on("open", () => {
        console.log("✅ Connected to PumpPortal WebSocket");
        isConnected = true;
        socket?.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    socket.on("message", async (raw) => {
        // Safely convert WebSocket.Data to string
        let text: string;
        if (typeof raw === "string") {
            text = raw;
        } else if (raw instanceof Buffer) {
            text = raw.toString("utf-8");
        } else if (Array.isArray(raw)) {
            text = Buffer.concat(raw).toString("utf-8");
        } else if (raw instanceof ArrayBuffer) {
            text = Buffer.from(raw).toString("utf-8");
        } else if (ArrayBuffer.isView(raw)) {
            text = Buffer.from(raw.buffer).toString("utf-8");
        } else {
            console.error("Unrecognized WebSocket data type");
            return;
        }

        const data = JSON.parse(text);
        if (data.txType !== "create") return;

        const pool = data.pool; // "bonk" or "pump" or other
        const rawMint = data.mint;

        // Decide whether to normalize or use raw mint
        let mint: string;
        if (pool === "pump" || pool === "bonk") {
            // Curve pools: use raw mint directly
            mint = rawMint;
        } else {
            // Non-curve: validate Base58 public key
            const normalized = normalizeMint(rawMint, pool);
            if (!normalized) {
                console.warn(`⚠️ Could not normalize mint for ${rawMint}`);
                return;
            }
            mint = normalized;
        }

        const token: PumpToken = {
            mint,
            pool,
            signature: data.signature,
            creator: data.traderPublicKey,
            launchedAt: data.launchedAt ?? Date.now(),
            simulatedLp:
                pool === "bonk"
                    ? data.solInPool
                    : (data.vSolInBondingCurve ?? 0) + (data.solAmount ?? 0),
            earlyHolders: pool === "pump" ? data.vTokensInBondingCurve ?? 0 : 0,
            hasJupiterRoute: false,
            lpTokenAddress: pool,
            metadata: {
                name: data.name,
                symbol: data.symbol,
                decimals: data.decimals ?? 0,
            },
            launchSpeedSeconds: data.launchSpeedSeconds ?? 0,
        };

        // Enqueue and notify
        pendingTokens.set(mint, token);
        recordLaunch(token.creator);
        onNewToken(token);
    });

    socket.on("close", () => {
        console.warn("🔌 PumpPortal socket closed. Reconnecting in 3s...");
        isConnected = false;
        setTimeout(() => monitorPumpPortal(onNewToken), 3_000);
    });

    socket.on("error", (err) => {
        console.error("❌ PumpPortal WebSocket error:", err.message);
    });

    // Clean up old seenMints entries
    setInterval(() => {
        const now = Date.now();
        for (const m of Object.keys(seenMints)) {
            if (now - seenMints[m] > SEEN_TTL_MS) {
                delete seenMints[m];
            }
        }
    }, 60_000);
}
