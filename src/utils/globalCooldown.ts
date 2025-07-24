// src/utils/globalCooldown.ts

let lastGlobalCooldownUntil = 0;

export function shouldCooldown(): boolean {
    return Date.now() < lastGlobalCooldownUntil;
}

export function triggerCooldown(durationMs: number) {
    lastGlobalCooldownUntil = Date.now() + durationMs;
    console.warn(`⏳ Triggered global cooldown for ${durationMs / 1000}s`);
}
