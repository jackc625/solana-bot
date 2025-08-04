// getSlot.js (ESM-compatible)
import { Connection } from "@solana/web3.js";

const endpoint = "https://compatible-crimson-sun.solana-mainnet.quiknode.pro/51f66c0dfd5baaf8ab48adcb9876f8d93be7e29c/";
const solana = new Connection(endpoint);

const slot = await solana.getSlot();
console.log("✅ Current slot:", slot);
