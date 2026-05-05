/*
 * admin.ts — typed client for the DATE auth service's admin endpoints.
 *
 * Wire shape mirrors `server/auth/models.py` and `server/auth/routes/{users,invite}.py`
 * verbatim. Same-origin paths under `/auth/*`; the SPA never names a
 * deployment hostname.
 *
 * Endpoint map (from architecture/identity.md §"Endpoints"):
 *   GET    /auth/users              → { users: User[] }
 *   POST   /auth/invites            → InviteCreateResponse  (201)
 *   GET    /auth/invites            → { invites: Invite[] } (pending only)
 *   DELETE /auth/invites/{id}       → { message: string }
 *   PUT    /auth/users/{id}/role    → User                 (the updated row)
 *   DELETE /auth/users/{id}         → { message: string }
 *
 * All admin endpoints require `role=admin`. The auth service answers 403
 * for non-admin sessions and 401 for missing/expired sessions; apiFetch
 * handles 401 by redirecting to /auth/login. 4xx other than 401 surfaces
 * here as `AdminApiError` for the caller to render inline.
 *
 * Test seam — every fn accepts an optional `fetchFn` so unit tests can
 * drive responses directly without going through `apiFetch`. Mirrors the
 * pattern in `assetCatalog.ts` and `whoami.ts`.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { apiFetch } from "./apiFetch";
import { UnauthenticatedError } from "./whoami";


// ---- Wire types — must match server/auth/models.py ----------------------

export type Role = "admin" | "user";

/** One row from `GET /auth/users`. Mirrors `UserOut` in `server/auth/models.py`. */
export interface User {
    id: string;
    email: string;
    /** Server returns `None` (→ JSON `null`) when the IdP didn't supply
     * a name. UI renders an em-dash placeholder for null. */
    display_name: string | null;
    role: Role;
    /** ISO8601 UTC. */
    created_at: string;
    /** ISO8601 UTC, or `null` if the user has never logged in. */
    last_login_at: string | null;
    active: boolean;
}

/** One row from `GET /auth/invites`. Mirrors `InviteOut`. The server
 * filters to pending-only (un-consumed, un-revoked, un-expired), so the
 * client doesn't need to repeat that check. */
export interface Invite {
    id: string;
    email: string;
    role: Role;
    /** User id of the inviter — server stores `cur.user.id` (UUID).
     * Display layer resolves to email/display_name via the users list. */
    invited_by: string;
    created_at: string;
    expires_at: string;
}

/** Body of `POST /auth/invites`. Mirrors `InviteCreateResponse`. The
 * server returns the URL even when SMTP fails so the admin can share
 * the invite manually; `email_sent === false` triggers the manual-share
 * banner in the UI. */
export interface CreateInviteResponse {
    id: string;
    invite_url: string;
    expires_at: string;
    email: string;
    role: Role;
    email_sent: boolean;
    /** Populated when `email_sent === false`; null/undefined otherwise.
     * Server field is `email_warning` (not `email_error`) — matches
     * `InviteCreateResponse` in models.py. */
    email_warning: string | null;
}


// ---- Error type ---------------------------------------------------------

/** Thrown by every admin API call on non-2xx responses or transport
 * failures. `status` is the HTTP code, or -1 for transport-level
 * failures (connection refused, DNS error, etc.). The message includes
 * the server's `detail` text when available so the caller can surface
 * actionable errors inline (e.g. 409 "cannot delete the currently
 * signed-in account" on self-removal). */
export class AdminApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "AdminApiError";
        this.status = status;
    }
}


// ---- Internal helpers ---------------------------------------------------

interface BaseOpts {
    /** Override the fetch impl for tests. When supplied, bypasses
     * `apiFetch` entirely (so tests don't have to stub the redirect
     * handler). When omitted, `apiFetch` is used and 401 triggers a
     * full-page redirect to /auth/login. */
    fetchFn?: typeof fetch;
    /** AbortSignal for cancelling the request (e.g. on unmount). */
    signal?: AbortSignal;
}

/** Run a request through either the injected fetch or apiFetch. */
async function doRequest(
    path: string,
    init: RequestInit,
    fetchFn: typeof fetch | undefined,
): Promise<Response> {
    if (fetchFn) {
        const resp = await fetchFn(path, {
            ...init,
            credentials: init.credentials ?? "include",
        });
        if (resp.status === 401) {
            throw new UnauthenticatedError();
        }
        return resp;
    }
    return apiFetch(path, init);
}

/** Pull a server-side `detail` string out of a response body. The auth
 * service raises `HTTPException(detail=...)` which serializes to
 * `{"detail": "..."}`; we surface that to the user verbatim when
 * available, so 409 self-deletion or 404 user-not-found render with
 * the server's exact wording. */
async function readDetail(resp: Response): Promise<string> {
    let detail = `${resp.status} ${resp.statusText}`;
    try {
        const body = await resp.text();
        if (body) {
            try {
                const j = JSON.parse(body) as { detail?: unknown };
                if (j && typeof j.detail === "string" && j.detail.length > 0) {
                    return `${resp.status} ${j.detail}`;
                }
            } catch {
                /* not JSON; fall through */
            }
            detail += ` — ${body.slice(0, 200)}`;
        }
    } catch {
        /* ignore */
    }
    return detail;
}

/** Wrap thrown errors in AdminApiError unless they're abort/auth-redirect
 * (those propagate unchanged). */
function wrapError(err: unknown, label: string): never {
    if (err instanceof UnauthenticatedError) {
        throw err;
    }
    if (err instanceof Error && err.name === "AbortError") {
        throw err;
    }
    if (err instanceof AdminApiError) {
        throw err;
    }
    throw new AdminApiError(
        -1,
        `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
}


// ---- Public API ---------------------------------------------------------

/**
 * `GET /auth/users` — list every registered user (admin-only).
 *
 * Returns the rows in the order the server returned them (server orders
 * by `created_at` ascending). Throws `AdminApiError` on non-2xx and on
 * malformed bodies (missing `users` array, etc.).
 */
export async function listUsers(opts: BaseOpts = {}): Promise<User[]> {
    let resp: Response;
    try {
        resp = await doRequest(
            "/auth/users",
            { method: "GET", headers: { Accept: "application/json" }, signal: opts.signal },
            opts.fetchFn,
        );
    } catch (err) {
        wrapError(err, "GET /auth/users");
    }

    if (!resp.ok) {
        throw new AdminApiError(resp.status, `GET /auth/users: ${await readDetail(resp)}`);
    }

    let parsed: unknown;
    try {
        parsed = await resp.json();
    } catch (err) {
        throw new AdminApiError(
            resp.status,
            `GET /auth/users returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!parsed || typeof parsed !== "object") {
        throw new AdminApiError(resp.status, `GET /auth/users: expected object, got ${typeof parsed}`);
    }
    const users = (parsed as { users?: unknown }).users;
    if (!Array.isArray(users)) {
        throw new AdminApiError(resp.status, "GET /auth/users: missing users[] in response");
    }
    return users.map(coerceUser).filter((u): u is User => u !== null);
}


/**
 * `GET /auth/invites` — list pending invites (admin-only). Server filters
 * out consumed, revoked, and expired invites before responding, so the
 * client gets only the actionable ones.
 */
export async function listInvites(opts: BaseOpts = {}): Promise<Invite[]> {
    let resp: Response;
    try {
        resp = await doRequest(
            "/auth/invites",
            { method: "GET", headers: { Accept: "application/json" }, signal: opts.signal },
            opts.fetchFn,
        );
    } catch (err) {
        wrapError(err, "GET /auth/invites");
    }

    if (!resp.ok) {
        throw new AdminApiError(resp.status, `GET /auth/invites: ${await readDetail(resp)}`);
    }

    let parsed: unknown;
    try {
        parsed = await resp.json();
    } catch (err) {
        throw new AdminApiError(
            resp.status,
            `GET /auth/invites returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!parsed || typeof parsed !== "object") {
        throw new AdminApiError(resp.status, `GET /auth/invites: expected object, got ${typeof parsed}`);
    }
    const invites = (parsed as { invites?: unknown }).invites;
    if (!Array.isArray(invites)) {
        throw new AdminApiError(resp.status, "GET /auth/invites: missing invites[] in response");
    }
    return invites.map(coerceInvite).filter((i): i is Invite => i !== null);
}


/**
 * `POST /auth/invites` — create an invite (admin-only). Body is
 * `{email, role}`; response includes the invite URL even when SMTP
 * delivery fails so the admin can share manually. Caller branches on
 * `email_sent` to choose the success message.
 */
export async function createInvite(
    email: string,
    role: Role,
    opts: BaseOpts = {},
): Promise<CreateInviteResponse> {
    let resp: Response;
    try {
        resp = await doRequest(
            "/auth/invites",
            {
                method: "POST",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ email, role }),
                signal: opts.signal,
            },
            opts.fetchFn,
        );
    } catch (err) {
        wrapError(err, "POST /auth/invites");
    }

    if (!resp.ok) {
        throw new AdminApiError(resp.status, `POST /auth/invites: ${await readDetail(resp)}`);
    }

    let parsed: unknown;
    try {
        parsed = await resp.json();
    } catch (err) {
        throw new AdminApiError(
            resp.status,
            `POST /auth/invites returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const out = coerceCreateInviteResponse(parsed);
    if (out === null) {
        throw new AdminApiError(resp.status, "POST /auth/invites: malformed response body");
    }
    return out;
}


/**
 * `DELETE /auth/invites/{id}` — revoke a pending invite (admin-only).
 * Resolves on 2xx; throws AdminApiError otherwise. The server returns
 * 409 if the invite was already consumed, which the caller surfaces.
 */
export async function revokeInvite(
    id: string,
    opts: BaseOpts = {},
): Promise<void> {
    let resp: Response;
    try {
        resp = await doRequest(
            `/auth/invites/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: { Accept: "application/json" }, signal: opts.signal },
            opts.fetchFn,
        );
    } catch (err) {
        wrapError(err, "DELETE /auth/invites");
    }

    if (!resp.ok) {
        throw new AdminApiError(resp.status, `DELETE /auth/invites: ${await readDetail(resp)}`);
    }
}


/**
 * `PUT /auth/users/{id}/role` — change a user's role (admin-only).
 * Server returns the updated user row, but the UI typically refreshes
 * the list afterwards anyway, so we return void to keep the call sites
 * uniform with `revokeInvite` / `removeUser`.
 */
export async function changeRole(
    userId: string,
    role: Role,
    opts: BaseOpts = {},
): Promise<void> {
    let resp: Response;
    try {
        resp = await doRequest(
            `/auth/users/${encodeURIComponent(userId)}/role`,
            {
                method: "PUT",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ role }),
                signal: opts.signal,
            },
            opts.fetchFn,
        );
    } catch (err) {
        wrapError(err, "PUT /auth/users/{id}/role");
    }

    if (!resp.ok) {
        throw new AdminApiError(resp.status, `PUT /auth/users/{id}/role: ${await readDetail(resp)}`);
    }
}


/**
 * `DELETE /auth/users/{id}` — remove a user (admin-only). Server
 * terminates the user's active sessions atomically; 409 is returned if
 * the admin tries to remove their own account (the UI hides the button
 * for that row anyway, but we honor the server's enforcement either way).
 */
export async function removeUser(
    userId: string,
    opts: BaseOpts = {},
): Promise<void> {
    let resp: Response;
    try {
        resp = await doRequest(
            `/auth/users/${encodeURIComponent(userId)}`,
            { method: "DELETE", headers: { Accept: "application/json" }, signal: opts.signal },
            opts.fetchFn,
        );
    } catch (err) {
        wrapError(err, "DELETE /auth/users");
    }

    if (!resp.ok) {
        throw new AdminApiError(resp.status, `DELETE /auth/users: ${await readDetail(resp)}`);
    }
}


// ---- Defensive coercion -------------------------------------------------

/** Map an unknown object to User; return null when the row is missing
 * required fields. Mirrors the pattern in `assetCatalog.ts`: drop one
 * malformed row rather than blow up the whole response. */
function coerceUser(raw: unknown): User | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    const email = typeof r.email === "string" ? r.email : null;
    const role = r.role === "admin" || r.role === "user" ? r.role : null;
    if (!id || !email || !role) return null;
    return {
        id,
        email,
        display_name: typeof r.display_name === "string" ? r.display_name : null,
        role,
        created_at: typeof r.created_at === "string" ? r.created_at : "",
        last_login_at: typeof r.last_login_at === "string" ? r.last_login_at : null,
        active: typeof r.active === "boolean" ? r.active : true,
    };
}

function coerceInvite(raw: unknown): Invite | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    const email = typeof r.email === "string" ? r.email : null;
    const role = r.role === "admin" || r.role === "user" ? r.role : null;
    if (!id || !email || !role) return null;
    return {
        id,
        email,
        role,
        invited_by: typeof r.invited_by === "string" ? r.invited_by : "",
        created_at: typeof r.created_at === "string" ? r.created_at : "",
        expires_at: typeof r.expires_at === "string" ? r.expires_at : "",
    };
}

function coerceCreateInviteResponse(raw: unknown): CreateInviteResponse | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : null;
    const invite_url = typeof r.invite_url === "string" ? r.invite_url : null;
    const expires_at = typeof r.expires_at === "string" ? r.expires_at : null;
    const email = typeof r.email === "string" ? r.email : null;
    const role = r.role === "admin" || r.role === "user" ? r.role : null;
    if (!id || !invite_url || !expires_at || !email || !role) return null;
    return {
        id,
        invite_url,
        expires_at,
        email,
        role,
        email_sent: typeof r.email_sent === "boolean" ? r.email_sent : false,
        email_warning: typeof r.email_warning === "string" ? r.email_warning : null,
    };
}
