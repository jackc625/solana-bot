import fs from "fs/promises";
import path from "path";

const blacklistPath = path.resolve(
    new URL("../..", import.meta.url).pathname,
    "data/blacklist.json"
);

let _cachedBlacklist: Set<string> | null = null;

export async function loadBlacklist(): Promise<Set<string>> {
    if (_cachedBlacklist) return _cachedBlacklist;

    try {
        const raw = await fs.readFile(blacklistPath, "utf-8");
        const parsed = JSON.parse(raw) as string[];
        _cachedBlacklist = new Set(parsed.map(addr => addr.toLowerCase()));
    } catch {
        _cachedBlacklist = new Set();
    }

    return _cachedBlacklist;
}

export async function addToBlacklist(creator: string): Promise<void> {
    const lower = creator.toLowerCase();
    const blacklist = await loadBlacklist();

    if (blacklist.has(lower)) return; // already there

    blacklist.add(lower);
    _cachedBlacklist = blacklist;

    const updated = JSON.stringify(Array.from(blacklist), null, 2);
    await fs.writeFile(blacklistPath, updated, "utf-8");

    console.log(`🚫 Blacklisted creator: ${creator}`);
}
