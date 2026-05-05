/*
 * InviteForm — modal form for `POST /auth/invites`.
 *
 * Behavior:
 *   - Email (required, basic client-side validation) + role dropdown
 *     (default User).
 *   - On submit, calls `createInvite(email, role)`.
 *   - On success with `email_sent === true`: success banner with the
 *     invite URL and a copy-to-clipboard button (in case the admin
 *     wants to share via another channel). Auto-dismisses 5s after
 *     the user opens or via explicit Close.
 *   - On success with `email_sent === false`: a different banner —
 *     "email could not be sent: <warning>" — with the URL + copy
 *     button, and NO auto-dismiss (the admin needs to act).
 *   - On error: inline error message; modal stays open.
 *
 * Modal pattern: a backdrop div + centered card. No portal-less library
 * yet — we render at the bottom of AdminPage so z-index handles layering.
 *
 * Copy-to-clipboard: uses `navigator.clipboard.writeText` when present;
 * falls back to a textarea + execCommand for older environments. The
 * fallback is necessary because jsdom doesn't ship `clipboard` and some
 * older browsers (or non-HTTPS deployments) won't either.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    createInvite,
    AdminApiError,
    type Role,
    type CreateInviteResponse,
} from "../../services/admin";


export interface InviteFormProps {
    /** Called when the user explicitly closes the modal (Cancel,
     * Close, or auto-dismiss after a successful email send). The
     * parent decides whether the invite list needs to refresh; we
     * pass back a flag indicating if at least one invite was created
     * during this session of the modal. */
    onClose: (createdSomething: boolean) => void;

    /** Override the fetch impl for tests. */
    fetchFn?: typeof fetch;

    /** Optional injection seam for tests — when present, replaces the
     * navigator.clipboard / execCommand fallback so we can verify the
     * copy button without touching real clipboard APIs. */
    copyImpl?: (text: string) => Promise<void>;

    /** Auto-dismiss delay in ms (after a successful email send).
     * Default 5000; tests pass 0 to skip the timer. */
    autoDismissMs?: number;
}


type State =
    | { kind: "form"; email: string; role: Role; clientError: string | null; submitting: boolean; submitError: string | null }
    | { kind: "success-email-sent"; resp: CreateInviteResponse; copied: boolean }
    | { kind: "success-email-failed"; resp: CreateInviteResponse; copied: boolean };


// Email regex — pragmatic, not RFC-perfect. The server validates
// authoritatively (`InviteCreateRequest._email_shape` in models.py);
// we just want to catch obvious typos before the round-trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


export function InviteForm({
    onClose,
    fetchFn,
    copyImpl,
    autoDismissMs = 5000,
}: InviteFormProps) {
    const [state, setState] = useState<State>({
        kind: "form",
        email: "",
        role: "user",
        clientError: null,
        submitting: false,
        submitError: null,
    });

    /** Did we successfully create at least one invite during this
     * modal's lifecycle? Bubbled up to the parent so it can refresh
     * the invite list on close even when the user re-uses the modal
     * for multiple invites (not a v1 flow but cheap to support). */
    const createdRef = useRef(false);

    /** Auto-dismiss timer for the success-email-sent state. Cleared
     * on unmount and on state transitions. */
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => () => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    useEffect(() => {
        // Schedule auto-dismiss when entering success-email-sent.
        if (state.kind === "success-email-sent" && autoDismissMs > 0) {
            timerRef.current = setTimeout(() => {
                onClose(createdRef.current);
            }, autoDismissMs);
            return () => {
                if (timerRef.current !== null) {
                    clearTimeout(timerRef.current);
                    timerRef.current = null;
                }
            };
        }
        return undefined;
    }, [state.kind, autoDismissMs, onClose]);

    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (state.kind !== "form") return;

        const email = state.email.trim().toLowerCase();
        if (!email) {
            setState({ ...state, clientError: "Email is required" });
            return;
        }
        if (!EMAIL_RE.test(email)) {
            setState({ ...state, clientError: "Enter a valid email address" });
            return;
        }

        setState({ ...state, clientError: null, submitting: true, submitError: null });
        try {
            const resp = await createInvite(email, state.role, { fetchFn });
            createdRef.current = true;
            if (resp.email_sent) {
                setState({ kind: "success-email-sent", resp, copied: false });
            } else {
                setState({ kind: "success-email-failed", resp, copied: false });
            }
        } catch (err) {
            const message = err instanceof AdminApiError
                ? err.message
                : (err instanceof Error ? err.message : String(err));
            setState({ ...state, submitting: false, submitError: message });
        }
    }, [state, fetchFn]);

    const handleCopy = useCallback(async (url: string) => {
        const fn = copyImpl ?? defaultCopyToClipboard;
        try {
            await fn(url);
            setState((prev) => {
                if (prev.kind === "success-email-sent" || prev.kind === "success-email-failed") {
                    return { ...prev, copied: true };
                }
                return prev;
            });
        } catch {
            // Silent — the URL is right there; user can select it.
        }
    }, [copyImpl]);

    const handleClose = useCallback(() => {
        if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        onClose(createdRef.current);
    }, [onClose]);

    return (
        <div className="admin-modal-backdrop" data-testid="invite-form-backdrop">
            <div
                className="admin-modal"
                data-testid="invite-form-modal"
                role="dialog"
                aria-labelledby="invite-form-title"
            >
                <h2 id="invite-form-title" className="admin-modal-title">Invite a user</h2>
                <p className="admin-modal-subtitle">
                    The invitee receives an email with a link they use to sign in for the first time.
                </p>

                {(state.kind === "form") && (
                    <FormBody
                        state={state}
                        onChange={(next) => setState(next)}
                        onSubmit={handleSubmit}
                        onCancel={handleClose}
                    />
                )}

                {(state.kind === "success-email-sent") && (
                    <SuccessEmailSent
                        resp={state.resp}
                        copied={state.copied}
                        onCopy={() => void handleCopy(state.resp.invite_url)}
                        onClose={handleClose}
                    />
                )}

                {(state.kind === "success-email-failed") && (
                    <SuccessEmailFailed
                        resp={state.resp}
                        copied={state.copied}
                        onCopy={() => void handleCopy(state.resp.invite_url)}
                        onClose={handleClose}
                    />
                )}
            </div>
        </div>
    );
}


// ---- Subcomponents ------------------------------------------------------

function FormBody({
    state,
    onChange,
    onSubmit,
    onCancel,
}: {
    state: Extract<State, { kind: "form" }>;
    onChange: (next: Extract<State, { kind: "form" }>) => void;
    onSubmit: (e: React.FormEvent) => void;
    onCancel: () => void;
}) {
    return (
        <form onSubmit={onSubmit} data-testid="invite-form">
            <div className="admin-modal-field">
                <label className="admin-modal-label" htmlFor="invite-email">Email</label>
                <input
                    id="invite-email"
                    className="admin-modal-input"
                    data-testid="invite-form-email"
                    type="email"
                    value={state.email}
                    onChange={(e) => onChange({ ...state, email: e.target.value, clientError: null })}
                    placeholder="person@example.com"
                    autoComplete="off"
                    autoFocus
                    disabled={state.submitting}
                    required
                />
            </div>

            <div className="admin-modal-field">
                <label className="admin-modal-label" htmlFor="invite-role">Role</label>
                <select
                    id="invite-role"
                    className="admin-modal-select"
                    data-testid="invite-form-role"
                    value={state.role}
                    onChange={(e) => onChange({ ...state, role: e.target.value as Role })}
                    disabled={state.submitting}
                >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                </select>
            </div>

            {state.clientError && (
                <div className="admin-modal-error" data-testid="invite-form-client-error">
                    {state.clientError}
                </div>
            )}
            {state.submitError && (
                <div className="admin-modal-error" data-testid="invite-form-submit-error">
                    {state.submitError}
                </div>
            )}

            <div className="admin-modal-actions">
                <button
                    type="button"
                    className="admin-modal-button"
                    data-testid="invite-form-cancel"
                    onClick={onCancel}
                    disabled={state.submitting}
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    className="admin-modal-button admin-modal-button-primary"
                    data-testid="invite-form-submit"
                    disabled={state.submitting}
                >
                    {state.submitting ? "Sending…" : "Send invite"}
                </button>
            </div>
        </form>
    );
}


function SuccessEmailSent({
    resp,
    copied,
    onCopy,
    onClose,
}: {
    resp: CreateInviteResponse;
    copied: boolean;
    onCopy: () => void;
    onClose: () => void;
}) {
    return (
        <div data-testid="invite-form-success-sent">
            <div className="admin-modal-success">
                Invite sent to <strong>{resp.email}</strong>. They have until {formatExpiry(resp.expires_at)} to accept.
            </div>
            <p className="admin-modal-subtitle" style={{ marginTop: 12, marginBottom: 6 }}>
                If you need to share the link another way:
            </p>
            <div className="admin-modal-link-block">
                <span className="admin-modal-link-text" data-testid="invite-form-url">{resp.invite_url}</span>
                <button
                    type="button"
                    className="admin-modal-copy-button"
                    data-testid="invite-form-copy"
                    onClick={onCopy}
                >
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <div className="admin-modal-actions">
                <button
                    type="button"
                    className="admin-modal-button admin-modal-button-primary"
                    data-testid="invite-form-close"
                    onClick={onClose}
                >
                    Close
                </button>
            </div>
        </div>
    );
}


function SuccessEmailFailed({
    resp,
    copied,
    onCopy,
    onClose,
}: {
    resp: CreateInviteResponse;
    copied: boolean;
    onCopy: () => void;
    onClose: () => void;
}) {
    return (
        <div data-testid="invite-form-success-failed">
            <div className="admin-modal-warning">
                Invite created, but the email could not be sent
                {resp.email_warning ? `: ${resp.email_warning}` : "."}
                <br />
                Please share this link with <strong>{resp.email}</strong> manually:
            </div>
            <div className="admin-modal-link-block">
                <span className="admin-modal-link-text" data-testid="invite-form-url">{resp.invite_url}</span>
                <button
                    type="button"
                    className="admin-modal-copy-button"
                    data-testid="invite-form-copy"
                    onClick={onCopy}
                >
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <div className="admin-modal-actions">
                <button
                    type="button"
                    className="admin-modal-button admin-modal-button-primary"
                    data-testid="invite-form-close"
                    onClick={onClose}
                >
                    Close
                </button>
            </div>
        </div>
    );
}


// ---- Helpers ------------------------------------------------------------

function formatExpiry(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
}

/** Default clipboard implementation. Prefers the Async Clipboard API
 * when available (HTTPS-only on most browsers); falls back to a hidden
 * textarea + execCommand for legacy contexts. Throws on failure so the
 * caller can fall through silently. */
async function defaultCopyToClipboard(text: string): Promise<void> {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
    }
    if (typeof document === "undefined") {
        throw new Error("clipboard unavailable");
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand("copy");
    } finally {
        document.body.removeChild(ta);
    }
}
