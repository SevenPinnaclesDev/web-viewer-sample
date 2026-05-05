/*
 * AdminEntry — top-level mount point for the /admin path.
 *
 * Mirrors the auth-gate pattern in StreamOnlyWindow / Window: fetch
 * /auth/whoami on mount, branch on the outcome, and only render
 * AdminPage when we have a confirmed identity. The 401 path is the
 * same — runAuthGate triggers a full-page redirect to /auth/login.
 *
 * Why this exists separate from App: App brings in the streaming
 * infrastructure (AppStream, signaling URLs, kit-app config) which
 * is irrelevant to the admin UI. Mounting AdminPage at the same
 * level keeps the admin path lightweight and lets us evolve the
 * two surfaces independently.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { runAuthGate } from "../../services/authGate";
import type { User } from "../../services/whoami";
import { AdminPage } from "./AdminPage";


/** Internal auth state — same shape used by App / StreamOnlyWindow,
 * just hoisted to a hook here. */
type AuthState =
    | { kind: "pending" }
    | { kind: "ready"; user: User }
    | { kind: "redirected" }
    | { kind: "error"; message: string };


export interface AdminEntryProps {
    /** Override the fetch impl for tests. Forwarded to runAuthGate
     * AND to AdminPage so a single fetch stub drives the whole flow. */
    fetchFn?: typeof fetch;
}


export function AdminEntry({ fetchFn }: AdminEntryProps = {}) {
    const [auth, setAuth] = useState<AuthState>({ kind: "pending" });
    const abortRef = useRef<AbortController | null>(null);

    const runAuth = useCallback(async () => {
        abortRef.current?.abort();
        const ctl = new AbortController();
        abortRef.current = ctl;
        setAuth({ kind: "pending" });
        const outcome = await runAuthGate({ signal: ctl.signal, fetchFn });
        if (ctl.signal.aborted) return;
        if (outcome.kind === "ok") {
            setAuth({ kind: "ready", user: outcome.user });
        } else if (outcome.kind === "redirected") {
            setAuth({ kind: "redirected" });
        } else {
            setAuth({ kind: "error", message: outcome.message });
        }
    }, [fetchFn]);

    useEffect(() => {
        void runAuth();
        return () => {
            abortRef.current?.abort();
        };
    }, [runAuth]);

    if (auth.kind === "pending") {
        return (
            <div className="loading-indicator-label" data-testid="admin-entry-pending">
                Checking session…
            </div>
        );
    }
    if (auth.kind === "redirected") {
        return (
            <div className="loading-indicator-label" data-testid="admin-entry-redirected">
                Redirecting to sign in…
            </div>
        );
    }
    if (auth.kind === "error") {
        return (
            <div className="loading-indicator-label" data-testid="admin-entry-error">
                <div>Couldn't verify session.</div>
                <div style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>{auth.message}</div>
                <button
                    className="nvidia-button"
                    style={{ marginTop: 12 }}
                    onClick={() => { void runAuth(); }}
                    data-testid="admin-entry-retry"
                >
                    Retry
                </button>
            </div>
        );
    }

    // The whoami response only carries email/role/display_name; the
    // server's WhoAmIResponse adds user_id but the SPA's `User` type
    // (services/whoami.ts) drops that for historical reasons. The
    // admin page needs the user_id (to identify the self row), so we
    // re-fetch enough context here. The simplest way: extend the
    // whoami parser to surface user_id. Done in the whoami service
    // module so the rest of the app picks it up too.
    return (
        <AdminPage
            currentUser={{
                id: auth.user.user_id,
                email: auth.user.email,
                role: auth.user.role,
                display_name: auth.user.display_name,
            }}
            fetchFn={fetchFn}
        />
    );
}
