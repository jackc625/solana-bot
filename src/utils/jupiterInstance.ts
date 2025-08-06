// src/utils/jupiterInstance.ts

import { Jupiter } from "@jup-ag/core";
import { connection } from "./solana.js";
import { PublicKey } from "@solana/web3.js";

let jupiterInstance: Jupiter | null = null;

export const getJupiter = async (user: PublicKey): Promise<Jupiter | null> => {
    if (jupiterInstance) return jupiterInstance;

    try {
        jupiterInstance = await Jupiter.load({
            connection,
            cluster: "mainnet-beta",
            user,
        });

        return jupiterInstance;
    } catch (err: any) {
        if (err.message?.includes("Missing poolStateAccountInfo")) {
            console.warn("⚠️ Jupiter pool state not ready — returning null instance");
            return null;
        }

        console.error("❌ Failed to initialize Jupiter:", err);
        return null;
    }
};
