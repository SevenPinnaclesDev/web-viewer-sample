/*
 * apiBase.ts — same-origin URL helpers for the DATE SPA.
 *
 * Per `architecture/identity.md` §"SPA login flow": the SPA, the auth
 * service, the ingest service, and the kit-app stream all live behind a
 * single Caddy at `https://<deployment-hostname>/`. Caddy reverse-proxies
 * each path prefix to the right upstream:
 *
 *   /              → SPA static bundle
 *   /auth/*        → auth service
 *   /api/*         → ingest service
 *   /stream/*      → kit-app signaling
 *
 * The browser therefore never needs to know about a separate "ingest
 * service host" or a "stream host" — every fetch and WebSocket targets
 * its own origin. There is no per-deployment hostname assumption baked
 * into the SPA.
 *
 * Dev override: `import.meta.env.VITE_API_BASE` lets a developer point
 * the SPA at a non-same-origin backend (a remote substrate while running
 * vite dev, for example). Production default is empty same-origin.
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */

/**
 * Resolve the dev override at call time. Read inside `apiBase()` rather
 * than captured at module load so vite's bundle inlines the production
 * value but tests can override per-call via `setApiBaseOverride`.
 */
function resolveEnvBase(): string | undefined {
    try {
        const env = (import.meta as ImportMeta).env as Record<string, string | undefined> | undefined;
        return env?.VITE_API_BASE;
    } catch {
        return undefined;
    }
}

let testOverride: string | undefined = undefined;

/**
 * Test seam — overrides the value `apiBase()` returns. Pass `undefined`
 * to clear. Production code never calls this.
 */
export function setApiBaseOverride(value: string | undefined): void {
    testOverride = value;
}

/**
 * Base URL for backend HTTP calls. Empty string in production = same
 * origin (paths like `/api/...` resolve against the page's location).
 * In dev, `VITE_API_BASE` can be set to e.g. `https://staging.example`
 * to point at a remote backend without rebuilding.
 */
export function apiBase(): string {
    const raw = testOverride !== undefined ? testOverride : resolveEnvBase();
    if (typeof raw === "string" && raw.length > 0) {
        return raw.replace(/\/$/, "");
    }
    return "";
}

/**
 * Join the base + a leading-slash path. Used by every same-origin fetch.
 * Tolerant of paths supplied with or without a leading slash.
 */
export function apiUrl(path: string): string {
    const base = apiBase();
    const normalized = path.startsWith("/") ? path : `/${path}`;
    return `${base}${normalized}`;
}

/**
 * Build a WebSocket URL relative to the current page origin (or the
 * configured `VITE_API_BASE` in dev). Picks `wss://` for `https://`
 * pages and `ws://` for `http://`. Tolerant of paths supplied with or
 * without a leading slash.
 *
 * Used for the ingest lifecycle WS (`/api/ingest/ws/{job_id}`) and
 * could be reused for the kit-app stream signaling WS once that path
 * is wired through Caddy at `/stream/...`.
 */
export function wsUrl(path: string): string {
    const base = apiBase();
    const normalized = path.startsWith("/") ? path : `/${path}`;
    if (base) {
        return base.replace(/^http/, "ws") + normalized;
    }
    if (typeof window === "undefined" || !window.location) {
        return normalized;
    }
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${scheme}//${window.location.host}${normalized}`;
}
