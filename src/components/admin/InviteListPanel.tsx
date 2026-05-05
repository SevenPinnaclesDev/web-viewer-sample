/*
 * InviteListPanel — table of pending invites with a per-row Revoke
 * action. The server returns only un-consumed, un-revoked, un-expired
 * invites by default (server's `list_pending_invites` filters), so we
 * don't need to filter client-side.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { useCallback, useState } from "react";
import {
    revokeInvite,
    AdminApiError,
    type Invite,
    type User,
} from "../../services/admin";


export interface InviteListPanelProps {
    invites: Invite[];
    /** All users — used to resolve `invited_by` (a user id) to an
     * email or display name. Nullable for the moment when the user
     * list hasn't loaded yet; in that case we surface the raw id so
     * the UI never shows "undefined". */
    users: User[];
    /** Called after a revoke succeeds; parent re-fetches. */
    onMutated: () => void;
    fetchFn?: typeof fetch;
    confirmImpl?: (message: string) => boolean;
}


export function InviteListPanel({
    invites,
    users,
    onMutated,
    fetchFn,
    confirmImpl,
}: InviteListPanelProps) {
    const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
    const [busy, setBusy] = useState<Set<string>>(new Set());

    const confirm = confirmImpl ?? ((m: string) => {
        if (typeof window !== "undefined" && typeof window.confirm === "function") {
            return window.confirm(m);
        }
        return true;
    });

    const handleRevoke = useCallback(async (inv: Invite) => {
        const message = `Revoke the invite for ${inv.email}?\n\nThe link will stop working immediately.`;
        if (!confirm(message)) return;

        setRowError(null);
        setBusy((prev) => {
            const next = new Set(prev);
            next.add(inv.id);
            return next;
        });
        try {
            await revokeInvite(inv.id, { fetchFn });
            onMutated();
        } catch (err) {
            const detail = err instanceof AdminApiError
                ? err.message
                : (err instanceof Error ? err.message : String(err));
            setRowError({ id: inv.id, message: detail });
        } finally {
            setBusy((prev) => {
                const next = new Set(prev);
                next.delete(inv.id);
                return next;
            });
        }
    }, [confirm, fetchFn, onMutated]);

    if (invites.length === 0) {
        return (
            <div className="admin-empty-card" data-testid="invite-list-empty">
                <div className="admin-empty-title">No pending invites</div>
                <div className="admin-empty-message">
                    Use "Invite user" to send someone a sign-in link.
                </div>
            </div>
        );
    }

    return (
        <table className="admin-table" data-testid="invite-list-table">
            <thead>
                <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Invited by</th>
                    <th>Expires</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                {invites.map((inv) => {
                    const inviter = resolveInviter(inv.invited_by, users);
                    const isBusy = busy.has(inv.id);
                    const error = rowError && rowError.id === inv.id ? rowError.message : null;
                    return (
                        <tr key={inv.id} data-testid="invite-list-row" data-invite-id={inv.id}>
                            <td>{inv.email}</td>
                            <td>
                                <span className={`admin-role-badge ${inv.role === "admin" ? "admin-role-admin" : "admin-role-user"}`}>
                                    {inv.role}
                                </span>
                            </td>
                            <td>{inviter}</td>
                            <td className="admin-cell-muted">{formatExpires(inv.expires_at)}</td>
                            <td className="admin-cell-actions">
                                {error && (
                                    <div className="admin-modal-error" data-testid="invite-list-row-error" style={{ marginBottom: 4 }}>
                                        {error}
                                    </div>
                                )}
                                <button
                                    className="admin-row-button admin-row-button-danger"
                                    data-testid="invite-list-revoke"
                                    onClick={() => void handleRevoke(inv)}
                                    disabled={isBusy}
                                >
                                    Revoke
                                </button>
                            </td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}


// ---- Helpers ------------------------------------------------------------

function resolveInviter(invitedBy: string, users: User[]): string {
    const match = users.find((u) => u.id === invitedBy);
    if (!match) return invitedBy; // surface raw id rather than empty
    return match.display_name ?? match.email;
}

/**
 * Format an expiration timestamp as a "in N days/hours" string. Past
 * dates surface as "expired" (the server filters them out by default,
 * but a row could expire between page load and render).
 */
function formatExpires(iso: string): string {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const seconds = Math.floor((t - Date.now()) / 1000);
    if (seconds <= 0) return "expired";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.floor(hours / 24);
    return `in ${days} day${days === 1 ? "" : "s"}`;
}
