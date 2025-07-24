import fs from "fs/promises";
import path from "path";

const tradeLogPath = path.resolve("data", "trades.json");
const errorLogPath = path.resolve("data", "errors.log");

await fs.mkdir("data", { recursive: true });

export async function logTrade(entry: Record<string, any>) {
    const timestamp = new Date().toISOString();
    const fullEntry = { timestamp, ...entry };

    try {
        let existing: any[] = [];
        try {
            const raw = await fs.readFile(tradeLogPath, "utf-8");
            existing = JSON.parse(raw);
        } catch {
            existing = [];
        }

        existing.push(fullEntry);
        await fs.writeFile(tradeLogPath, JSON.stringify(existing, null, 2));
    } catch (err) {
        console.error("❌ Failed to write trade log:", err);
    }
}

export async function logError(error: any, context?: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${context ? `[${context}] ` : ""}${error?.message || error}\n`;

    try {
        await fs.appendFile(errorLogPath, line);
    } catch (err) {
        console.error("❌ Failed to write error log:", err);
    }
}

