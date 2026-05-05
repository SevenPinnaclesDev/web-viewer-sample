/*
 * UserListPanel — table of users, with per-row actions for role toggle
 * and removal. Receives the user list + the current admin's id (so the
 * panel can hide the Remove button on the admin's own row — server
 * enforces this with 409, but the UI shouldn't dare the user into the
 * error path). Confirmation dialogs use `window.confirm` for v1; an
 * inline confirm pattern can be added in a future polish pass.
 *
 * Optimistic update: role toggle flips the visible role immediately,
 * rolls back on error (with a banner). Remove waits for the round-trip
 * (the row disappears from the list anyway, so there's no perceptual
 * benefit to optimistic rendering, and the rollback would be ugly).
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { useCallback, useState } from "react";
import {
    changeRole,
    removeUser,
    AdminApiError,
    type Role,
    type User,
} from "../../services/admin";


export interface UserListPanelProps {
    users: User[];
    /** ID of the admin currently signed in. The Remove button is hidden
     * for this row so the admin can't accidentally lock themselves out
     * (server returns 409 if they try). */
    currentUserId: string;
    /** Called after a mutation succeeds; parent re-fetches the list. */
    onMutated: () => void;
    /** Override the fetch impl for tests. */
    fetchFn?: typeof fetch;
    /** Override window.confirm for tests. */
    confirmImpl?: (message: string) => boolean;
}


export function UserListPanel({
    users,
    currentUserId,
    onMutated,
    fetchFn,
    confirmImpl,
}: UserListPanelProps) {
    /** Per-row error message — clears on next successful mutation or
     * when the user starts another action on the same row. */
    const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

    /** Set of user ids that have a mutation in flight. Disables both
     * action buttons on that row. */
    const [busy, setBusy] = useState<Set<string>>(new Set());

    /** Optimistic role overrides — when a toggle is in flight we render
     * the *target* role so the UI feels instant. Rolled back on error. */
    const [roleOverrides, setRoleOverrides] = useState<Record<string, Role>>({});

    const confirm = confirmImpl ?? ((m: string) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
            return window.confirm(m);
        }
        return true;
    });

    const markBusy = useCallback((id: string, on: boolean) => {
        setBusy((prev) => {
            const next = new Set(prev);
            if (on) next.add(id); else next.delete(id);
            return next;
        });
    }, []);

    const handleToggleRole = useCallback(async (user: User) => {
        const target: Role = user.role === "admin" ? "user" : "admin";
        const message = `Change ${user.email}'s role from ${user.role} to ${target}?`;
        if (!confirm(message)) return;

        setRowError(null);
        setRoleOverrides((prev) => ({ ...prev, [user.id]: target }));
        markBusy(user.id, true);
        try {
            await changeRole(user.id, target, { fetchFn });
            // Roll the override forward: clear it so the parent's refresh
            // is the source of truth.
            setRoleOverrides((prev) => {
                const next = { ...prev };
                delete next[user.id];
                return next;
            });
            onMutated();
        } catch (err) {
            // Rollback the optimistic override.
            setRoleOverrides((prev) => {
                const next = { ...prev };
                delete next[user.id];
                return next;
            });
            const detail = err instanceof AdminApiError
                ? err.message
                : (err instanceof Error ? err.message : String(err));
            setRowError({ id: user.id, message: detail });
        } finally {
            markBusy(user.id, false);
        }
    }, [confirm, fetchFn, markBusy, onMutated]);

    const handleRemove = useCallback(async (user: User) => {
        const message =
            `Remove ${user.email}?\n\n` +
            `This will terminate their active sessions and they will need to be ` +
            `re-invited to regain access. Removing a user does not delete their content.`;
        if (!confirm(message)) return;

        setRowError(null);
        markBusy(user.id, true);
        try {
            await removeUser(user.id, { fetchFn });
            onMutated();
        } catch (err) {
            const detail = err instanceof AdminApiError
                ? err.message
                : (err instanceof Error ? err.message : String(err));
            setRowError({ id: user.id, message: detail });
        } finally {
            markBusy(user.id, false);
        }
    }, [confirm, fetchFn, markBusy, onMutated]);

    if (users.length === 0) {
        return (
            <div className="admin-empty-card" data-testid="user-list-empty">
                <div className="admin-empty-title">No users yet</div>
                <div className="admin-empty-message">Invite someone to get started.</div>
            </div>
        );
    }

    return (
        <table className="admin-table" data-testid="user-list-table">
            <thead>
                <tr>
                    <th>Email</th>
                    <th>Display name</th>
                    <th>Role</th>
                    <th>Last login</th>
                    <th>Status</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                {users.map((u) => {
                    const effectiveRole = roleOverrides[u.id] ?? u.role;
                    const isSelf = u.id === currentUserId;
                    const isBusy = busy.has(u.id);
                    const error = rowError && rowError.id === u.id ? rowError.message : null;
                    return (
                        <tr key={u.id} data-testid="user-list-row" data-user-id={u.id}>
                            <td>{u.email}</td>
                            <td>{u.display_name ?? <span className="admin-cell-muted">—</span>}</td>
                            <td>
                                <span
                                    className={`admin-role-badge ${effectiveRole === "admin" ? "admin-role-admin" : "admin-role-user"}`}
                                    data-testid="user-list-role"
                                >
                                    {effectiveRole}
                                </span>
                            </td>
                            <td className="admin-cell-muted">{formatRelative(u.last_login_at)}</td>
                            <td>
                                {u.active
                                    ? <span className="admin-status-active">Active</span>
                                    : <span className="admin-status-inactive">Inactive</span>}
                            </td>
                            <td className="admin-cell-actions">
                                {error && (
                                    <div className="admin-modal-error" data-testid="user-list-row-error" style={{ marginBottom: 4 }}>
                                        {error}
                                    </div>
                                )}
                                <button
                                    className="admin-row-button"
                                    data-testid="user-list-toggle-role"
                                    onClick={() => void handleToggleRole(u)}
                                    disabled={isBusy}
                                    title={`Change role to ${effectiveRole === "admin" ? "user" : "admin"}`}
                                >
                                    {effectiveRole === "admin" ? "Demote" : "Promote"}
                                </button>
                                {!isSelf && (
                                    <button
                                        className="admin-row-button admin-row-button-danger"
                                        data-testid="user-list-remove"
                                        onClick={() => void handleRemove(u)}
                                        disabled={isBusy}
                                    >
                                        Remove
                                    </button>
                                )}
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}


// ---- Helpers ------------------------------------------------------------

/**
 * Render an ISO8601 timestamp as a relative string ("2 hours ago",
 * "3 days ago"). Falls back to "never" on null and to the raw string
 * on parse failure. Conservative buckets — no "just now" precision
 * needed for the admin context.
 */
function formatRelative(iso: string | null): string {
    if (!iso) return "never";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const now = Date.now();
    const seconds = Math.floor((now - t) / 1000);
    if (seconds < 60) return "moments ago";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? "" : "s"} ago`;
}
