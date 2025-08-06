// sliding 1-hour window of launch timestamps per creator
const WINDOW_MS = 60 * 60 * 1000;
const creatorLaunches = new Map<string, number[]>();

export function recordLaunch(creator: string) {
    const now = Date.now();
    const arr = creatorLaunches.get(creator) || [];
    // keep only last WINDOW_MS
    creatorLaunches.set(
        creator,
        arr.filter(ts => now - ts < WINDOW_MS).concat(now)
    );
}

export function getLaunchCount(creator: string): number {
    const now = Date.now();
    return (creatorLaunches.get(creator) || []).filter(ts => now - ts < WINDOW_MS).length;
}
