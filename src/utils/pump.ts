import fetch from "node-fetch";

export type PumpMetadata = {
    mint: string;
    creator: string;
    firstBuyer: string;
    virtualSolReserves: number;
    createdAt: number;
    metadataUri?: string;
};

export async function getPumpMetadata(mint: string): Promise<PumpMetadata | null> {
    try {
        const url = `https://pump.fun/coin/${mint}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const json = (await res.json()) as PumpMetadata;
        return json;
    } catch (err) {
        console.warn(`⚠️ Failed to load pump.fun metadata for ${mint}:`, err);
        return null;
    }
}
