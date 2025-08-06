// src/utils/telegram.ts

import fetch from "node-fetch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

/**
 * Sends a Markdown-formatted message to the configured Telegram chat.
 */
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

/**
 * Initializes the Telegram bot interface. No local commands are registered.
 */
export function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("⚠️ Telegram bot token or chat ID not set, skipping init");
        return;
    }

    console.log("✅ Telegram bot initialized (no command handlers registered)");
}
