const bs58 = require("bs58");
const fs = require("fs");

const key = JSON.parse(fs.readFileSync("./solana-devnet.json"));
const secretKey = Uint8Array.from(key);
const b58 = bs58.encode(secretKey);

console.log("PRIVATE_KEY=", b58);
