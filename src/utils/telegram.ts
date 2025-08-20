// src/utils/telegram.ts
// Standardize on Undici/global fetch (see src/init/fetchPatch.ts). Remove node-fetch usage.

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

export async function sendTelegramMessage(message: string) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("⚠️ Telegram bot token or chat ID missing");
        return;
    }

    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: message,
                parse_mode: "Markdown",
            }),
        });

        if (!res.ok) {
            const t = await res.text().catch(() => "");
            console.warn(`⚠️ Telegram send failed: ${res.status} ${t}`);
        }
    } catch (err) {
        console.warn("⚠️ Telegram send error:", (err as Error)?.message || err);
    }
}

export function startTelegramBot() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.warn("⚠️ Telegram bot token or chat ID not set, skipping init");
        return;
    }
    console.log("✅ Telegram bot initialized (no command handlers registered)");
}
