/*
 * AdminHeaderLink — small header-corner link to /admin, visible only
 * when the current user has the admin role.
 *
 * Renders as a plain anchor pointing at `/admin` so the browser does
 * a full-page navigation (which is what we want — admin and stream
 * are different surfaces with different state). Returns `null` for
 * non-admin users so it occupies no space.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import type { User } from "../../services/whoami";


export interface AdminHeaderLinkProps {
    user: User;
}


export function AdminHeaderLink({ user }: AdminHeaderLinkProps) {
    if (user.role !== "admin") return null;
    return (
        <a
            className="admin-header-link"
            href="/admin"
            data-testid="admin-header-link"
        >
            Admin
        </a>
    );
}
