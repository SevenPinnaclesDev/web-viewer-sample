/*
 * AdminEntry tests — verify the auth gate flow lifts the whoami
 * response into AdminPage's currentUser prop.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AdminEntry } from "../AdminEntry";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}


describe("AdminEntry", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders pending state initially, then AdminPage when whoami resolves to admin", async () => {
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("/auth/whoami")) {
                return makeResponse({
                    email: "elena@mfo.example",
                    role: "admin",
                    display_name: "Elena",
                    user_id: "u-1",
                });
            }
            if (url.includes("/auth/users")) return makeResponse({ users: [] });
            if (url.includes("/auth/invites")) return makeResponse({ invites: [] });
            return makeResponse({}, 404);
        });
        render(<AdminEntry fetchFn={fetchSpy as unknown as typeof fetch} />);
        await waitFor(() => expect(screen.getByTestId("admin-page")).toBeInTheDocument());
        expect(screen.getByTestId("admin-page-tab-users")).toBeInTheDocument();
    });

    it("renders not-admin empty state when whoami resolves to role=user", async () => {
        const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
            if (url.includes("/auth/whoami")) {
                return makeResponse({
                    email: "user@example.com",
                    role: "user",
                    display_name: null,
                    user_id: "u-2",
                });
            }
            return makeResponse({}, 404);
        });
        render(<AdminEntry fetchFn={fetchSpy as unknown as typeof fetch} />);
        await waitFor(() => expect(screen.getByTestId("admin-page-not-admin")).toBeInTheDocument());
    });

    it("renders error state with retry on 5xx whoami", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "down" }, 503));
        render(<AdminEntry fetchFn={fetchSpy as unknown as typeof fetch} />);
        await waitFor(() => expect(screen.getByTestId("admin-entry-error")).toBeInTheDocument());
        expect(screen.getByTestId("admin-entry-retry")).toBeInTheDocument();
    });
});
