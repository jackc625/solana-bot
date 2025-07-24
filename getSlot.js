// getSlot.js
import { config } from "dotenv";            // if you’re using a .env file
import { Connection } from "@solana/web3.js";

config();                                    // load .env vars

const QUICKNODE_RPC = process.env.QUICKNODE_RPC
    || "https://tame-light-tree.solana-devnet.quiknode.pro/44b4ce9fcfffd532ab71c163b478ccb5a8dcb8d1/";

(async () => {
    const connection = new Connection(QUICKNODE_RPC);
    const slot = await connection.getSlot();
    console.log("Current slot:", slot);
})();

