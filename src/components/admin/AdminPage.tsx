/*
 * AdminPage — entry point for the /admin route. Gates on the current
 * user's role: non-admin users see a clean empty card directing them
 * back to the streaming UI; admins see Users / Invites tabs and the
 * Invite User CTA.
 *
 * State model:
 *   - `currentUser` is supplied by the parent (App-level whoami fetch).
 *     We don't refetch whoami here; the parent already gated on it.
 *   - On mount (admin path only), fetch users + invites in parallel.
 *     Each section has its own loading/error state, but a top-level
 *     error from either renders an inline retry banner inside the
 *     active tab.
 *   - `refresh()` re-fetches both lists; called by mutation handlers
 *     in the panels.
 *
 * Modal: when the Invite User CTA is clicked, we render `InviteForm`
 * inline at the bottom of the page (its z-index handles layering).
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    listUsers,
    listInvites,
    AdminApiError,
    type User,
    type Invite,
} from "../../services/admin";
import { UnauthenticatedError } from "../../services/whoami";
import { UserListPanel } from "./UserListPanel";
import { InviteListPanel } from "./InviteListPanel";
import { InviteForm } from "./InviteForm";
import "./AdminPage.css";


export interface AdminPageProps {
    /** The currently-signed-in user, as returned by /auth/whoami. */
    currentUser: { id: string; email: string; role: "admin" | "user"; display_name?: string | null };
    /** Override fetch impl for tests. */
    fetchFn?: typeof fetch;
    /** Override window.confirm for tests. */
    confirmImpl?: (m: string) => boolean;
    /** Override clipboard impl for tests. */
    copyImpl?: (text: string) => Promise<void>;
    /** Auto-dismiss delay for the success-email-sent state of InviteForm.
     * Tests pass 0 to skip the timer. */
    inviteAutoDismissMs?: number;
}


type Tab = "users" | "invites";

type ListState<T> =
    | { kind: "loading" }
    | { kind: "loaded"; rows: T[] }
    | { kind: "error"; message: string };


export function AdminPage({
    currentUser,
    fetchFn,
    confirmImpl,
    copyImpl,
    inviteAutoDismissMs,
}: AdminPageProps) {
    const [tab, setTab] = useState<Tab>("users");
    const [usersState, setUsersState] = useState<ListState<User>>({ kind: "loading" });
    const [invitesState, setInvitesState] = useState<ListState<Invite>>({ kind: "loading" });
    const [inviteFormOpen, setInviteFormOpen] = useState(false);

    const abortRef = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        if (currentUser.role !== "admin") return;
        abortRef.current?.abort();
        const ctl = new AbortController();
        abortRef.current = ctl;

        setUsersState({ kind: "loading" });
        setInvitesState({ kind: "loading" });

        // Parallel fetch — each list resolves independently so a
        // transient failure in one doesn't blank the other.
        await Promise.all([
            (async () => {
                try {
                    const rows = await listUsers({ fetchFn, signal: ctl.signal });
                    if (ctl.signal.aborted) return;
                    setUsersState({ kind: "loaded", rows });
                } catch (err) {
                    if (err instanceof UnauthenticatedError) return;
                    if (err instanceof Error && err.name === "AbortError") return;
                    const message = err instanceof AdminApiError
                        ? err.message
                        : (err instanceof Error ? err.message : String(err));
                    setUsersState({ kind: "error", message });
                }
            })(),
            (async () => {
                try {
                    const rows = await listInvites({ fetchFn, signal: ctl.signal });
                    if (ctl.signal.aborted) return;
                    setInvitesState({ kind: "loaded", rows });
                } catch (err) {
                    if (err instanceof UnauthenticatedError) return;
                    if (err instanceof Error && err.name === "AbortError") return;
                    const message = err instanceof AdminApiError
                        ? err.message
                        : (err instanceof Error ? err.message : String(err));
                    setInvitesState({ kind: "error", message });
                }
            })(),
        ]);
    }, [currentUser.role, fetchFn]);

    useEffect(() => {
        void refresh();
        return () => {
            abortRef.current?.abort();
        };
    }, [refresh]);

    const handleInviteFormClose = useCallback((created: boolean) => {
        setInviteFormOpen(false);
        if (created) void refresh();
    }, [refresh]);

    // ---- Non-admin gate ---------------------------------------------

    if (currentUser.role !== "admin") {
        return (
            <div className="admin-page" data-testid="admin-page">
                <AdminPageHeader />
                <div className="admin-page-inner">
                    <div className="admin-empty-card" data-testid="admin-page-not-admin">
                        <div className="admin-empty-title">No admin access</div>
                        <div className="admin-empty-message">
                            You don't have admin permissions on this DATE deployment. Ask an
                            administrator if you need access.
                        </div>
                        <a className="admin-empty-link" href="/" data-testid="admin-page-back-link">
                            ← Back to DATE
                        </a>
                    </div>
                </div>
            </div>
        );
    }

    // ---- Admin view -------------------------------------------------

    const userRows = usersState.kind === "loaded" ? usersState.rows : [];

    return (
        <div className="admin-page" data-testid="admin-page">
            <AdminPageHeader />
            <div className="admin-page-inner">
                <div className="admin-page-toolbar">
                    <div className="admin-page-tabs" role="tablist">
                        <button
                            className={`admin-page-tab ${tab === "users" ? "admin-page-tab-active" : ""}`}
                            data-testid="admin-page-tab-users"
                            role="tab"
                            aria-selected={tab === "users"}
                            onClick={() => setTab("users")}
                        >
                            Users
                        </button>
                        <button
                            className={`admin-page-tab ${tab === "invites" ? "admin-page-tab-active" : ""}`}
                            data-testid="admin-page-tab-invites"
                            role="tab"
                            aria-selected={tab === "invites"}
                            onClick={() => setTab("invites")}
                        >
                            Invites
                        </button>
                    </div>
                    <button
                        className="admin-page-cta"
                        data-testid="admin-page-invite-cta"
                        onClick={() => setInviteFormOpen(true)}
                    >
                        Invite user
                    </button>
                </div>

                <div className="admin-page-section">
                    {tab === "users" && (
                        <UsersTab
                            state={usersState}
                            currentUserId={currentUser.id}
                            onRetry={() => void refresh()}
                            onMutated={() => void refresh()}
                            fetchFn={fetchFn}
                            confirmImpl={confirmImpl}
                        />
                    )}
                    {tab === "invites" && (
                        <InvitesTab
                            state={invitesState}
                            users={userRows}
                            onRetry={() => void refresh()}
                            onMutated={() => void refresh()}
                            fetchFn={fetchFn}
                            confirmImpl={confirmImpl}
                        />
                    )}
                </div>
            </div>

            {inviteFormOpen && (
                <InviteForm
                    onClose={handleInviteFormClose}
                    fetchFn={fetchFn}
                    copyImpl={copyImpl}
                    autoDismissMs={inviteAutoDismissMs}
                />
            )}
        </div>
    );
}


// ---- Admin page header --------------------------------------------------

function AdminPageHeader() {
    return (
        <div className="admin-page-header" data-testid="admin-page-header">
            <span className="admin-page-header-title">DATE</span>
            <span className="admin-page-header-subtitle">Admin</span>
            <a className="admin-page-header-back" href="/" data-testid="admin-page-header-back">
                ← Back to streaming
            </a>
        </div>
    );
}


// ---- Tab subcomponents --------------------------------------------------

function UsersTab({
    state,
    currentUserId,
    onRetry,
    onMutated,
    fetchFn,
    confirmImpl,
}: {
    state: ListState<User>;
    currentUserId: string;
    onRetry: () => void;
    onMutated: () => void;
    fetchFn?: typeof fetch;
    confirmImpl?: (m: string) => boolean;
}) {
    if (state.kind === "loading") {
        return <div className="admin-loading" data-testid="admin-page-users-loading">Loading users…</div>;
    }
    if (state.kind === "error") {
        return (
            <div className="admin-error" data-testid="admin-page-users-error">
                <div>Couldn't load users</div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>{state.message}</div>
                <button className="admin-retry" data-testid="admin-page-users-retry" onClick={onRetry}>
                    Retry
                </button>
            </div>
        );
    }
    return (
        <UserListPanel
            users={state.rows}
            currentUserId={currentUserId}
            onMutated={onMutated}
            fetchFn={fetchFn}
            confirmImpl={confirmImpl}
        />
    );
}

function InvitesTab({
    state,
    users,
    onRetry,
    onMutated,
    fetchFn,
    confirmImpl,
}: {
    state: ListState<Invite>;
    users: User[];
    onRetry: () => void;
    onMutated: () => void;
    fetchFn?: typeof fetch;
    confirmImpl?: (m: string) => boolean;
}) {
    if (state.kind === "loading") {
        return <div className="admin-loading" data-testid="admin-page-invites-loading">Loading invites…</div>;
    }
    if (state.kind === "error") {
        return (
            <div className="admin-error" data-testid="admin-page-invites-error">
                <div>Couldn't load invites</div>
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.8 }}>{state.message}</div>
                <button className="admin-retry" data-testid="admin-page-invites-retry" onClick={onRetry}>
                    Retry
                </button>
            </div>
        );
    }
    return (
        <InviteListPanel
            invites={state.rows}
            users={users}
            onMutated={onMutated}
            fetchFn={fetchFn}
            confirmImpl={confirmImpl}
        />
    );
}
