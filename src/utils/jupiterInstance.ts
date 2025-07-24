import { Jupiter } from "@jup-ag/core";
import { connection } from "./solana.js";
import { Keypair } from "@solana/web3.js";

let jupiterInstance: Jupiter | null = null;

export const getJupiter = async (): Promise<Jupiter> => {
    if (!jupiterInstance) {
        const dummyUser = Keypair.generate().publicKey; // Only required for Jupiter setup
        jupiterInstance = await Jupiter.load({
            connection,
            cluster: "mainnet-beta",
            user: dummyUser,
        });
    }

    return jupiterInstance;
};
