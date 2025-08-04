import fetch from "node-fetch";
import TelegramBot, { Message } from "node-telegram-bot-api";
import { getPumpMetadata } from "./pump.js";
import { scoreToken } from "../core/scoring.js";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

export async function sendTelegramMessage(message: string) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("⚠️ Telegram bot token or chat ID missing");
        return;
    }

    try {
        const res = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: TELEGRAM_CHAT_ID,
                    text: message,
                    parse_mode: "Markdown",
                }),
            }
        );

        if (!res.ok) {
            console.warn("❌ Telegram send failed:", await res.text());
        }
    } catch (err) {
        console.warn("🚨 Telegram error:", err);
    }
}

export function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn("⚠️ Telegram bot token not set, skipping bot init");
        return;
    }

    const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

    bot.onText(/^\/score\s+(.+)/i, async (msg: Message, match: RegExpExecArray | null) => {
        const chatId = msg.chat.id;
        const mint = match?.[1]?.trim();

        if (!mint || !mint.match(/^([1-9A-HJ-NP-Za-km-z]{32,44})$/)) {
            bot.sendMessage(chatId, `❌ Invalid mint address.`);
            return;
        }

        try {
            const meta = await getPumpMetadata(mint);
            if (!meta) {
                bot.sendMessage(chatId, `❌ Could not fetch metadata for ${mint}`);
                return;
            }

            const token = {
                mint: meta.mint,
                creator: meta.creator,
                metadata: {
                    name: "",         // Unknown from pump.fun API
                    symbol: "",       // Unknown from pump.fun API
                    decimals: 9,      // Default to 9 if unknown
                },
                earlyHolders: 100,     // Placeholder until you implement estimation
                launchSpeedSeconds: 60, // Placeholder
                simulatedLp: meta.virtualSolReserves ?? 1,
                rawData: meta,
            };

            const result = await scoreToken(token as any);
            const { score, details } = result;

            let msgText = `🧠 *Token Score Report*\n`;
            msgText += `Mint: \`${mint}\`\n`;
            msgText += `Score: ${score}/7\n`;

            for (const [k, v] of Object.entries(details)) {
                const emoji = v ? "✔️" : "❌";
                msgText += `${emoji} ${k}\n`;
            }

            bot.sendMessage(chatId, msgText, { parse_mode: "Markdown" });
        } catch (err) {
            console.error("Telegram score command failed:", err);
            bot.sendMessage(chatId, `❌ Error evaluating score for ${mint}`);
        }
    });
}
