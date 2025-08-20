// src/utils/withTimeout.ts
export async function withTimeout<T>(p: Promise<T>, ms = 1800, label = "operation"): Promise<T> {
    let id: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, rej) => {
        id = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
        // race your promise vs the timeout
        return (await Promise.race([p, timeout])) as T;
    } finally {
        if (id) clearTimeout(id);
    }
}

/**
 * fetch with an AbortController-based timeout.
 * Usage:
 *   await fetchWithTimeout(url, { method: "POST", body, headers, timeoutMs: 1800 })
 */
export async function fetchWithTimeout(
    input: RequestInfo | URL,
    init?: (RequestInit & { timeoutMs?: number }) | undefined
): Promise<Response> {
    const { timeoutMs = 1800, ...rest } = init ?? {};
    const ac = new AbortController();
    const p = fetch(input, { ...rest, signal: ac.signal });
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
        return await p;
    } finally {
        clearTimeout(t);
    }
}
