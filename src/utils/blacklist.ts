// src/utils/blacklist.ts

import fs from "fs/promises";
import path from "path";

// Always use <project-root>/data/blacklist.json
const blacklistPath = path.resolve(
    process.cwd(),
    "data",
    "blacklist.json"
);

let _cachedBlacklist: Set<string> | null = null;

/**
 * Load the blacklist (lowercased creators) from disk, or initialize empty.
 */
export async function loadBlacklist(): Promise<Set<string>> {
    if (_cachedBlacklist) return _cachedBlacklist;
    try {
        const raw = await fs.readFile(blacklistPath, "utf-8");
        const parsed = JSON.parse(raw) as string[];
        _cachedBlacklist = new Set(parsed.map((addr) => addr.toLowerCase()));
    } catch {
        _cachedBlacklist = new Set();
    }
    return _cachedBlacklist;
}

/**
 * Append a creator to the blacklist file (if not already present).
 * Creates the data directory and file as needed.
 */
export async function addToBlacklist(creator: string): Promise<void> {
    const lower = creator.toLowerCase();
    const blacklist = await loadBlacklist();

    if (blacklist.has(lower)) return; // already blacklisted

    // Add to set and persist
    blacklist.add(lower);
    _cachedBlacklist = blacklist;

    try {
        await fs.mkdir(path.dirname(blacklistPath), { recursive: true });
        const updated = JSON.stringify(Array.from(blacklist), null, 2);
        await fs.writeFile(blacklistPath, updated, "utf-8");
        console.log(`🚫 Blacklisted creator: ${creator}`);
    } catch (err: any) {
        console.warn("⚠️ Could not write blacklist file:", err.message || err);
    }
}