/*
 * UserListPanel tests — drive the table with mock users + stub fetch
 * + stub confirm. Cover empty state, render, role toggle, remove, and
 * the self-row Remove-button hide rule.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UserListPanel } from "../UserListPanel";
import type { User } from "../../../services/admin";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}

function user(overrides: Partial<User> = {}): User {
    return {
        id: "u-1",
        email: "elena@mfo.example",
        display_name: "Elena Reyes",
        role: "user",
        created_at: "2026-05-01T12:00:00+00:00",
        last_login_at: "2026-05-04T08:30:00+00:00",
        active: true,
        ...overrides,
    };
}


describe("UserListPanel", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders empty state when users is empty", () => {
        render(
            <UserListPanel
                users={[]}
                currentUserId="u-self"
                onMutated={vi.fn()}
            />,
        );
        expect(screen.getByTestId("user-list-empty")).toBeInTheDocument();
    });

    it("renders one row per user with email + role + status", () => {
        render(
            <UserListPanel
                users={[
                    user({ id: "u-1", email: "a@x", role: "admin", display_name: "A" }),
                    user({ id: "u-2", email: "b@x", role: "user", display_name: null, active: false }),
                ]}
                currentUserId="u-self"
                onMutated={vi.fn()}
            />,
        );
        const rows = screen.getAllByTestId("user-list-row");
        expect(rows).toHaveLength(2);
        expect(screen.getByText("a@x")).toBeInTheDocument();
        expect(screen.getByText("b@x")).toBeInTheDocument();
        expect(screen.getByText("Inactive")).toBeInTheDocument();
    });

    it("hides the Remove button on the current admin's own row", () => {
        render(
            <UserListPanel
                users={[
                    user({ id: "u-self", email: "me@x", role: "admin" }),
                    user({ id: "u-other", email: "them@x", role: "user" }),
                ]}
                currentUserId="u-self"
                onMutated={vi.fn()}
            />,
        );
        // Two rows, but only one Remove button — the non-self row.
        const removes = screen.getAllByTestId("user-list-remove");
        expect(removes).toHaveLength(1);
        // Verify it's on the non-self row.
        const otherRow = screen.getAllByTestId("user-list-row").find(
            (r) => r.getAttribute("data-user-id") === "u-other",
        );
        expect(otherRow?.contains(removes[0])).toBe(true);
    });

    it("Promote button confirms and calls PUT /role with role=admin", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "u-1", email: "a@x", role: "admin", active: true, created_at: "x",
        }));
        const onMutated = vi.fn();
        render(
            <UserListPanel
                users={[user({ id: "u-1", email: "a@x", role: "user" })]}
                currentUserId="u-self"
                onMutated={onMutated}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        fireEvent.click(screen.getByTestId("user-list-toggle-role"));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/users/u-1/role");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("PUT");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ role: "admin" });
        await waitFor(() => expect(onMutated).toHaveBeenCalled());
    });

    it("Demote button on an admin row sends role=user", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            id: "u-1", email: "a@x", role: "user", active: true, created_at: "x",
        }));
        render(
            <UserListPanel
                users={[user({ id: "u-1", role: "admin" })]}
                currentUserId="u-self"
                onMutated={vi.fn()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        // The button label is "Demote" when current role is admin.
        expect(screen.getByTestId("user-list-toggle-role")).toHaveTextContent("Demote");
        fireEvent.click(screen.getByTestId("user-list-toggle-role"));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ role: "user" });
    });

    it("does not call PUT if confirm returns false", async () => {
        const fetchSpy = vi.fn();
        render(
            <UserListPanel
                users={[user({ id: "u-1" })]}
                currentUserId="u-self"
                onMutated={vi.fn()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => false}
            />,
        );
        fireEvent.click(screen.getByTestId("user-list-toggle-role"));
        // Yield once so any in-flight async work would have a chance to fire.
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("shows row error on toggle failure and rolls back the optimistic role", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "bad request" }, 400));
        render(
            <UserListPanel
                users={[user({ id: "u-1", email: "a@x", role: "user" })]}
                currentUserId="u-self"
                onMutated={vi.fn()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        fireEvent.click(screen.getByTestId("user-list-toggle-role"));
        await waitFor(() => expect(screen.getByTestId("user-list-row-error")).toBeInTheDocument());
        // The role badge should still read "user" (rolled back).
        expect(screen.getByTestId("user-list-role")).toHaveTextContent("user");
    });

    it("Remove button confirms and calls DELETE /auth/users/{id}", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ message: "removed" }));
        const onMutated = vi.fn();
        render(
            <UserListPanel
                users={[user({ id: "u-1", email: "a@x" })]}
                currentUserId="u-self"
                onMutated={onMutated}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        fireEvent.click(screen.getByTestId("user-list-remove"));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/users/u-1");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("DELETE");
        await waitFor(() => expect(onMutated).toHaveBeenCalled());
    });

    it("Remove failure shows row error", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            detail: "cannot delete the currently signed-in account",
        }, 409));
        render(
            <UserListPanel
                users={[user({ id: "u-1" })]}
                currentUserId="u-self"
                onMutated={vi.fn()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                confirmImpl={() => true}
            />,
        );
        fireEvent.click(screen.getByTestId("user-list-remove"));
        await waitFor(() => expect(screen.getByTestId("user-list-row-error")).toBeInTheDocument());
        expect(screen.getByTestId("user-list-row-error")).toHaveTextContent(/currently signed-in/);
    });

    it("renders 'never' for users with last_login_at=null", () => {
        render(
            <UserListPanel
                users={[user({ id: "u-1", last_login_at: null })]}
                currentUserId="u-self"
                onMutated={vi.fn()}
            />,
        );
        expect(screen.getByText("never")).toBeInTheDocument();
    });
});
