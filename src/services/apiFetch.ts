/*
 * apiFetch.ts — same-origin fetch wrapper with 401-redirect behavior.
 *
 * Wraps `fetch` so that:
 *   - The URL is resolved through `apiUrl` (same-origin paths like
 *     `/api/...` resolve against the page origin or `VITE_API_BASE`).
 *   - `credentials: 'include'` ensures the session cookie rides along.
 *   - A 401 response triggers a full-page redirect to `/auth/login`
 *     with the current path as `return_to`, AND throws so the caller's
 *     promise chain doesn't continue against a stale response body.
 *
 * The redirect target matches `architecture/identity.md` §"SPA login
 * flow". Caddy's forward_auth would normally issue a redirect for
 * browser navigations, but XHR/fetch responses come back to JS as 401
 * — we have to drive the redirect ourselves on that path.
 *
 * The redirect function is injectable so tests can drive 401 paths
 * without actually navigating jsdom.
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */
import { apiUrl } from "./apiBase";
import { UnauthenticatedError } from "./whoami";

export type RedirectFn = (url: string) => void;

let redirectImpl: RedirectFn = (url: string) => {
    if (typeof window !== "undefined" && window.location) {
        window.location.href = url;
    }
};

/**
 * Override the redirect handler. Tests use this to capture the
 * intended URL without actually navigating. Returns the previous
 * handler so callers can restore it in afterEach.
 */
export function setRedirectImpl(fn: RedirectFn): RedirectFn {
    const prev = redirectImpl;
    redirectImpl = fn;
    return prev;
}

/**
 * Build the login URL with the current page's path+search as
 * `return_to`. Exposed for tests.
 */
export function buildLoginRedirectUrl(): string {
    if (typeof window === "undefined" || !window.location) {
        return apiUrl("/auth/login");
    }
    const here = window.location.pathname + window.location.search;
    return apiUrl(`/auth/login?return_to=${encodeURIComponent(here)}`);
}

export interface ApiFetchOptions extends RequestInit {
    /** Override the fetch impl for tests. Default: window.fetch. */
    fetchFn?: typeof fetch;
}

/**
 * Same-origin fetch with cookie credentials and 401 → login redirect.
 *
 * On 401: navigates to `/auth/login?return_to=<here>` AND throws
 * UnauthenticatedError so the caller's `.then` chain doesn't proceed.
 */
export async function apiFetch(path: string, init: ApiFetchOptions = {}): Promise<Response> {
    const { fetchFn, ...rest } = init;
    const fetchImpl = fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
        throw new Error("fetch unavailable in this environment");
    }

    const resp = await fetchImpl(apiUrl(path), {
        ...rest,
        credentials: rest.credentials ?? "include",
    });

    if (resp.status === 401) {
        redirectImpl(buildLoginRedirectUrl());
        throw new UnauthenticatedError();
    }

    return resp;
}
