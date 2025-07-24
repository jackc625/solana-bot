import WebSocket from "ws";

const ws = new WebSocket("wss://pumpportal.fun/api/data");
ws.on("open", () => {
    console.log("⏳ Connecting to PumpPortal…");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
});
ws.on("message", (data) => {
    console.log("📨 Raw event:", JSON.parse(data.toString()));
});
ws.on("error", (e) => console.error("❌ WS error:", e));
ws.on("close", (code) => console.warn("⚠️ WS closed:", code));
