import { fetch as undiciFetch } from "undici";

// Type-safe override using `any` to avoid TS mismatch with Node globals
globalThis.fetch = undiciFetch as any;
