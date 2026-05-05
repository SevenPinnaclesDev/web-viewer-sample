/*
 * authGate.ts — entry-point auth gating helper.
 *
 * Encapsulates the SPA login flow described in
 * `architecture/identity.md` §"SPA login flow":
 *
 *   1. On mount, GET /auth/whoami.
 *   2. 401 → redirect to /auth/login?return_to=<here> (full-page nav).
 *   3. Other failure → caller renders an error state with retry.
 *   4. Success → caller stores the User in state and renders the SPA.
 *
 * The redirect handler is injectable so tests can verify the 401 path
 * without actually navigating jsdom.
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */
import { getWhoAmI, UnauthenticatedError, type User } from "./whoami";
import { buildLoginRedirectUrl } from "./apiFetch";

export type AuthGateOutcome =
    | { kind: "ok"; user: User }
    | { kind: "redirected" }
    | { kind: "error"; message: string };

export interface RunAuthGateOptions {
    fetchFn?: typeof fetch;
    signal?: AbortSignal;
    /** Override the redirect handler for tests. Default: full-page nav. */
    redirect?: (url: string) => void;
}

/**
 * Run the entry-point auth check.
 *
 * Returns an outcome the caller branches on:
 *   - `ok` → render the SPA with the supplied user.
 *   - `redirected` → caller has already started a full-page nav; do
 *       not render anything (or render a minimal "Redirecting…" state).
 *   - `error` → render the error state with the supplied message and
 *       a retry button that re-invokes `runAuthGate`.
 */
export async function runAuthGate(opts: RunAuthGateOptions = {}): Promise<AuthGateOutcome> {
    const redirect = opts.redirect ?? ((url: string) => {
        if (typeof window !== "undefined" && window.location) {
            window.location.href = url;
        }
    });

    try {
        const user = await getWhoAmI({ fetchFn: opts.fetchFn, signal: opts.signal });
        return { kind: "ok", user };
    } catch (err) {
        if (err instanceof UnauthenticatedError) {
            redirect(buildLoginRedirectUrl());
            return { kind: "redirected" };
        }
        if (err instanceof Error && err.name === "AbortError") {
            return { kind: "error", message: "auth check aborted" };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "error", message };
    }
}
