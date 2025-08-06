import { normalizeMint } from "./src/utils/normalizeMint.js";

const mints = [
    "DxZV5FxgvGFWCHiyWxWzUc67feRQ8aFgwWndRGqspump", // Should be valid
    "DUtaaYA5prfner3P2AhrVoJrhohRm2vm2CTZU6FCbonk", // Should be valid
    "3Ny2DitMxpmgTSA8DWU2iYPYKzWLFDL1icePcddYpUMP", // Should be valid
    "So11111111111111111111111111111111111111112",  // Valid
];

for (const mint of mints) {
    const cleaned = normalizeMint(mint);
    if (cleaned) {
        console.log(`✅ Valid: ${cleaned}`);
    } else {
        console.log(`🚫 Skipped: ${mint}`);
    }
}
