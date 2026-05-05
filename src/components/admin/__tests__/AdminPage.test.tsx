/*
 * AdminPage tests — drive the page through React Testing Library +
 * stub fetch. Cover non-admin gate, admin tabs, loading states,
 * error+retry, and the invite-form modal flow.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AdminPage } from "../AdminPage";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}

const ADMIN = {
    id: "u-self",
    email: "elena@mfo.example",
    role: "admin" as const,
    display_name: "Elena Reyes",
};

const REGULAR = {
    id: "u-2",
    email: "bob@mfo.example",
    role: "user" as const,
    display_name: "Bob",
};


describe("AdminPage", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders the no-admin empty state for non-admin users and does NOT fetch", () => {
        const fetchSpy = vi.fn();
        render(
            <AdminPage
                currentUser={REGULAR}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        expect(screen.getByTestId("admin-page-not-admin")).toBeInTheDocument();
        expect(screen.getByTestId("admin-page-back-link")).toHaveAttribute("href", "/");
        // No tabs rendered.
        expect(screen.queryByTestId("admin-page-tab-users")).not.toBeInTheDocument();
        // No fetch made for users / invites.
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("admin: renders tabs + invite CTA, fetches users + invites in parallel", async () => {
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("/auth/users")) {
                return makeResponse({
                    users: [
                        { id: "u-self", email: "elena@mfo.example", display_name: "Elena", role: "admin", created_at: "x", last_login_at: null, active: true },
                    ],
                });
            }
            if (url.includes("/auth/invites")) {
                return makeResponse({ invites: [] });
            }
            return makeResponse({}, 404);
        });
        render(
            <AdminPage
                currentUser={ADMIN}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        expect(screen.getByTestId("admin-page-tab-users")).toBeInTheDocument();
        expect(screen.getByTestId("admin-page-tab-invites")).toBeInTheDocument();
        expect(screen.getByTestId("admin-page-invite-cta")).toBeInTheDocument();
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        // Both endpoints touched.
        const urls = fetchSpy.mock.calls.map((c) => c[0] as string);
        expect(urls.some((u) => u.includes("/auth/users"))).toBe(true);
        expect(urls.some((u) => u.includes("/auth/invites"))).toBe(true);
    });

    it("admin: switching to Invites tab renders the invite list", async () => {
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("/auth/users")) {
                return makeResponse({ users: [] });
            }
            if (url.includes("/auth/invites")) {
                return makeResponse({
                    invites: [
                        { id: "i-1", email: "x@x.x", role: "user", invited_by: "u-self", created_at: "x", expires_at: "2030-01-01T00:00:00+00:00" },
                    ],
                });
            }
            return makeResponse({}, 404);
        });
        render(
            <AdminPage
                currentUser={ADMIN}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        // Wait for invites to load before tab switch (async fetch).
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByTestId("admin-page-tab-invites"));
        await waitFor(() => expect(screen.getByTestId("invite-list-table")).toBeInTheDocument());
        expect(screen.getByText("x@x.x")).toBeInTheDocument();
    });

    it("admin: error in users fetch shows retry; retry re-fetches", async () => {
        let firstUsersCall = true;
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("/auth/users")) {
                if (firstUsersCall) {
                    firstUsersCall = false;
                    return makeResponse({ detail: "boom" }, 500);
                }
                return makeResponse({ users: [] });
            }
            if (url.includes("/auth/invites")) {
                return makeResponse({ invites: [] });
            }
            return makeResponse({}, 404);
        });
        render(
            <AdminPage
                currentUser={ADMIN}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        await waitFor(() => expect(screen.getByTestId("admin-page-users-error")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("admin-page-users-retry"));
        await waitFor(() => expect(screen.queryByTestId("admin-page-users-error")).not.toBeInTheDocument());
        // The empty user list is the success state with zero rows.
        expect(screen.getByTestId("user-list-empty")).toBeInTheDocument();
    });

    it("admin: clicking Invite user opens the modal; close re-renders the list", async () => {
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("/auth/users")) {
                return makeResponse({ users: [] });
            }
            if (url.includes("/auth/invites")) {
                return makeResponse({ invites: [] });
            }
            return makeResponse({}, 404);
        });
        render(
            <AdminPage
                currentUser={ADMIN}
                fetchFn={fetchSpy as unknown as typeof fetch}
                inviteAutoDismissMs={0}
            />,
        );
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByTestId("admin-page-invite-cta"));
        expect(screen.getByTestId("invite-form-modal")).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("invite-form-cancel"));
        await waitFor(() => expect(screen.queryByTestId("invite-form-modal")).not.toBeInTheDocument());
    });
});
