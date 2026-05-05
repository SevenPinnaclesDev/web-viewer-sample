/*
 * InviteListPanel tests — drive the table with mock invites + stub
 * fetch + stub confirm. Cover empty state, render, revoke, error path.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { InviteListPanel } from "../InviteListPanel";
import type { Invite, User } from "../../../services/admin";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}

function invite(overrides: Partial<Invite> = {}): Invite {
    return {
        id: "inv-1",
        email: "newperson@example.com",
        role: "user",
        invited_by: "u-1",
        created_at: "2026-05-04T08:00:00+00:00",
        // Far in the future so it never renders as "expired".
        expires_at: "2030-05-11T08:00:00+00:00",
        ...overrides,
    };
}

function user(overrides: Partial<User> = {}): User {
    return {
        id: "u-1",
        email: "elena@mfo.example",
        display_name: "Elena Reyes",
        role: "admin",
        created_at: "2026-05-01T12:00:00+00:00",
        last_login_at: null,
        active: true,
        ...overrides,
    };
}


describe("InviteListPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders empty state when invites is empty", () => {
        render(
            <InviteListPanel
                invites={[]}
                users={[]}
                onMutated={vi.fn()}
            />,
        );
        expect(screen.getByTestId("invite-list-empty")).toBeInTheDocument();
    });

    it("renders one row per invite with email + role + inviter resolved from users", () => {
        render(
            <InviteListPanel
                invites={[
                    invite({ id: "i-1", email: "a@x", invited_by: "u-1" }),
                    invite({ id: "i-2", email: "b@x", role: "admin", invited_by: "u-1" }),
                ]}
                users={[user({ id: "u-1", display_name: "Elena Reyes" })]}
                onMutated={vi.fn()}
            />,
        );
        const rows = screen.getAllByTestId("invite-list-row");
        expect(rows).toHaveLength(2);
        expect(screen.getByText("a@x")).toBeInTheDocument();
        // Inviter resolved to display name (Elena Reyes appears once per row).
        const inviterCells = screen.getAllByText("Elena Reyes");
        expect(inviterCells.length).toBeGreaterThanOrEqual(2);
    });

    it("falls back to invited_by id when no matching user is found", () => {
        render(
            <InviteListPanel
                invites={[invite({ invited_by: "unknown-id" })]}
                users={[user({ id: "u-1" })]}
                onMutated={vi.fn()}
            />,
        );
        expect(screen.getByText("unknown-id")).toBeInTheDocument();
    });

    it("Revoke button confirms and calls DELETE /auth/invites/{id}", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ message: "revoked" }));
        const onMutated = vi.fn();
        render(
            <InviteListPanel
                invites={[invite({ id: "i-99" })]}
                users={[]}
                onMutated={onMutated}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        fireEvent.click(screen.getByTestId("invite-list-revoke"));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/invites/i-99");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("DELETE");
        await waitFor(() => expect(onMutated).toHaveBeenCalled());
    });

    it("does not call DELETE if confirm returns false", async () => {
        const fetchSpy = vi.fn();
        render(
            <InviteListPanel
                invites={[invite()]}
                users={[]}
                onMutated={vi.fn()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => false}
            />,
        );
        fireEvent.click(screen.getByTestId("invite-list-revoke"));
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("shows row error when revoke fails (e.g. 409 already consumed)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            detail: "invite already consumed",
        }, 409));
        render(
            <InviteListPanel
                invites={[invite({ id: "i-1" })]}
                users={[]}
                onMutated={vi.fn()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        fireEvent.click(screen.getByTestId("invite-list-revoke"));
        await waitFor(() => expect(screen.getByTestId("invite-list-row-error")).toBeInTheDocument());
        expect(screen.getByTestId("invite-list-row-error")).toHaveTextContent(/already consumed/);
    });
});
