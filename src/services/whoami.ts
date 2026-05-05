/*
 * whoami.ts — fetch the currently-authenticated user's identity from
 * the auth service.
 *
 * Per `architecture/identity.md` §"SPA login flow", the entry-point
 * components call `getWhoAmI()` on mount:
 *   - 200 → continue rendering the SPA with the returned identity.
 *   - 401 → throw UnauthenticatedError; the caller redirects to
 *           `/auth/login?return_to=<current-path>` (full-page nav).
 *   - other status → throw with the HTTP status; caller renders an
 *           error state with a retry.
 *
 * Same-origin only — the request goes to `/auth/whoami` against the
 * page's origin. Caddy enforces session validity via forward_auth and
 * the auth service answers with the JSON body (or 401 if the cookie
 * is missing, expired, or revoked).
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */
import { apiUrl } from "./apiBase";

export interface User {
    email: string;
    role: "admin" | "user";
    display_name: string;
}

export class UnauthenticatedError extends Error {
    constructor() {
        super("not authenticated");
        this.name = "UnauthenticatedError";
    }
}

export class WhoAmIError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "WhoAmIError";
        this.status = status;
    }
}

export interface GetWhoAmIOptions {
    /** Override the fetch impl for tests. Default: window.fetch. */
    fetchFn?: typeof fetch;
    /** Optional AbortSignal so the caller can cancel on unmount. */
    signal?: AbortSignal;
}

/**
 * Fetch `/auth/whoami` with the session cookie included.
 *
 * Throws `UnauthenticatedError` on 401 (caller redirects to login).
 * Throws `WhoAmIError` with HTTP status on other non-2xx.
 * Throws on transport / parse failure.
 */
export async function getWhoAmI(opts: GetWhoAmIOptions = {}): Promise<User> {
    const fetchImpl = opts.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
        throw new WhoAmIError(-1, "fetch unavailable in this environment");
    }

    let resp: Response;
    try {
        resp = await fetchImpl(apiUrl("/auth/whoami"), {
            method: "GET",
            headers: { Accept: "application/json" },
            credentials: "include",
            signal: opts.signal,
        });
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            throw err;
        }
        throw new WhoAmIError(
            -1,
            `GET /auth/whoami failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (resp.status === 401) {
        throw new UnauthenticatedError();
    }

    if (!resp.ok) {
        let detail = `${resp.status} ${resp.statusText}`;
        try {
            const body = await resp.text();
            if (body) detail += ` — ${body.slice(0, 200)}`;
        } catch {
            /* fall through with status only */
        }
        throw new WhoAmIError(resp.status, `GET /auth/whoami: ${detail}`);
    }

    let parsed: unknown;
    try {
        parsed = await resp.json();
    } catch (err) {
        throw new WhoAmIError(
            resp.status,
            `GET /auth/whoami returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!parsed || typeof parsed !== "object") {
        throw new WhoAmIError(resp.status, `GET /auth/whoami: expected object, got ${typeof parsed}`);
    }

    const r = parsed as Record<string, unknown>;
    const email = typeof r.email === "string" ? r.email : null;
    const display_name = typeof r.display_name === "string" ? r.display_name : "";
    const roleRaw = typeof r.role === "string" ? r.role : null;
    if (!email || (roleRaw !== "admin" && roleRaw !== "user")) {
        throw new WhoAmIError(resp.status, "GET /auth/whoami: missing or invalid email/role");
    }
    return { email, role: roleRaw, display_name };
}
