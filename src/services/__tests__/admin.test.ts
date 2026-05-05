/*
 * admin service tests — exercise listUsers / listInvites / createInvite
 * / revokeInvite / changeRole / removeUser via stub fetch.
 *
 * Each call has at least a happy-path test and one error-path test
 * (4xx with detail, malformed body, transport failure). Mirrors the
 * density of `assetCatalog.test.ts`.
 *
 * Ryan Takeda — admin pages wave-2, 2026-05-04.
 */
import { describe, it, expect, vi } from "vitest";
import {
    listUsers,
    listInvites,
    createInvite,
    revokeInvite,
    changeRole,
    removeUser,
    AdminApiError,
    type User,
    type Invite,
    type CreateInviteResponse,
} from "../admin";


// ---- Helpers -------------------------------------------------------------

function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}

function sampleUser(overrides: Partial<User> = {}): User {
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

function sampleInvite(overrides: Partial<Invite> = {}): Invite {
    return {
        id: "inv-1",
        email: "newperson@mfo.example",
        role: "user",
        invited_by: "u-1",
        created_at: "2026-05-04T08:00:00+00:00",
        expires_at: "2026-05-11T08:00:00+00:00",
        ...overrides,
    };
}

function sampleCreateResp(
    overrides: Partial<CreateInviteResponse> = {},
): CreateInviteResponse {
    return {
        id: "inv-1",
        invite_url: "https://date.example/auth/invite/abc123",
        expires_at: "2026-05-11T08:00:00+00:00",
        email: "newperson@mfo.example",
        role: "user",
        email_sent: true,
        email_warning: null,
        ...overrides,
    };
}


// ---- listUsers ----------------------------------------------------------

describe("listUsers", () => {
    it("returns parsed User[] on 200 with {users: [...]}", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            users: [
                sampleUser({ id: "u-1", email: "a@x", role: "admin" }),
                sampleUser({ id: "u-2", email: "b@x", display_name: null, last_login_at: null }),
            ],
        }));
        const out = await listUsers({ fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out).toHaveLength(2);
        expect(out[0].role).toBe("admin");
        expect(out[1].display_name).toBeNull();
        expect(out[1].last_login_at).toBeNull();
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/users");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("GET");
        expect(init.credentials).toBe("include");
    });

    it("throws AdminApiError with status on non-2xx", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "forbidden" }, 403));
        await expect(listUsers({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBeInstanceOf(AdminApiError);
        try {
            await listUsers({ fetchFn: fetchSpy as unknown as typeof fetch });
        } catch (err) {
            expect((err as AdminApiError).status).toBe(403);
            expect((err as AdminApiError).message).toContain("forbidden");
        }
    });

    it("throws AdminApiError when body is missing users[]", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ wrong: "shape" }));
        await expect(listUsers({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toThrow(/users\[\]/);
    });

    it("drops malformed rows missing required fields", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            users: [
                sampleUser({ id: "u-1" }),
                { email: "no_id@x", role: "user" },           // no id → drop
                { id: "no_role", email: "x@x" },               // no role → drop
                sampleUser({ id: "u-2", role: "admin" }),
            ],
        }));
        const out = await listUsers({ fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out.map((u) => u.id)).toEqual(["u-1", "u-2"]);
    });
});


// ---- listInvites --------------------------------------------------------

describe("listInvites", () => {
    it("returns parsed Invite[] on 200 with {invites: [...]}", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            invites: [
                sampleInvite({ id: "i-1", email: "a@x" }),
                sampleInvite({ id: "i-2", email: "b@x", role: "admin" }),
            ],
        }));
        const out = await listInvites({ fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out).toHaveLength(2);
        expect(out[1].role).toBe("admin");
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/invites");
    });

    it("throws AdminApiError with status=-1 on transport failure", async () => {
        const fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(listInvites({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBeInstanceOf(AdminApiError);
        try {
            await listInvites({ fetchFn: fetchSpy as unknown as typeof fetch });
        } catch (err) {
            expect((err as AdminApiError).status).toBe(-1);
        }
    });

    it("returns [] when invites is empty", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ invites: [] }));
        const out = await listInvites({ fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out).toEqual([]);
    });
});


// ---- createInvite -------------------------------------------------------

describe("createInvite", () => {
    it("POSTs {email, role} JSON and returns the response on 201", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse(sampleCreateResp(), 201));
        const out = await createInvite("newperson@mfo.example", "user", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        });
        expect(out.email_sent).toBe(true);
        expect(out.invite_url).toContain("/auth/invite/");

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/invites");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("POST");
        expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ email: "newperson@mfo.example", role: "user" });
    });

    it("returns email_sent=false + email_warning when SMTP fails", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse(sampleCreateResp({
            email_sent: false,
            email_warning: "smtp connect refused",
        }), 201));
        const out = await createInvite("x@x", "admin", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        });
        expect(out.email_sent).toBe(false);
        expect(out.email_warning).toBe("smtp connect refused");
    });

    it("throws AdminApiError with detail on 422 (invalid email)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "invalid email address" }, 422));
        await expect(createInvite("not-an-email", "user", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).rejects.toBeInstanceOf(AdminApiError);
        try {
            await createInvite("not-an-email", "user", {
                fetchFn: fetchSpy as unknown as typeof fetch,
            });
        } catch (err) {
            expect((err as AdminApiError).status).toBe(422);
            expect((err as AdminApiError).message).toContain("invalid email");
        }
    });

    it("throws AdminApiError on malformed response body", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ wrong: "shape" }, 201));
        await expect(createInvite("x@x", "user", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).rejects.toThrow(/malformed/);
    });
});


// ---- revokeInvite -------------------------------------------------------

describe("revokeInvite", () => {
    it("DELETEs /auth/invites/{id} and resolves on 200", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ message: "revoked" }));
        await expect(revokeInvite("inv-123", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).resolves.toBeUndefined();
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/invites/inv-123");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("DELETE");
    });

    it("URL-encodes the invite id", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ message: "revoked" }));
        await revokeInvite("inv with spaces", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        });
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/invites/inv%20with%20spaces");
    });

    it("throws AdminApiError on 409 (already consumed)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "invite already consumed" }, 409));
        await expect(revokeInvite("inv-1", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).rejects.toBeInstanceOf(AdminApiError);
        try {
            await revokeInvite("inv-1", {
                fetchFn: fetchSpy as unknown as typeof fetch,
            });
        } catch (err) {
            expect((err as AdminApiError).status).toBe(409);
            expect((err as AdminApiError).message).toContain("already consumed");
        }
    });
});


// ---- changeRole ---------------------------------------------------------

describe("changeRole", () => {
    it("PUTs role payload to /auth/users/{id}/role and resolves on 200", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse(sampleUser({ role: "admin" })));
        await expect(changeRole("u-1", "admin", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).resolves.toBeUndefined();
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/users/u-1/role");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("PUT");
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ role: "admin" });
    });

    it("throws AdminApiError on 404", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "user not found" }, 404));
        await expect(changeRole("missing", "user", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).rejects.toBeInstanceOf(AdminApiError);
    });
});


// ---- removeUser ---------------------------------------------------------

describe("removeUser", () => {
    it("DELETEs /auth/users/{id} and resolves on 200", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ message: "removed" }));
        await expect(removeUser("u-1", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).resolves.toBeUndefined();
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/auth/users/u-1");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("DELETE");
    });

    it("throws AdminApiError on 409 (cannot delete self)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse(
            { detail: "cannot delete the currently signed-in account" },
            409,
        ));
        await expect(removeUser("u-self", {
            fetchFn: fetchSpy as unknown as typeof fetch,
        })).rejects.toBeInstanceOf(AdminApiError);
        try {
            await removeUser("u-self", {
                fetchFn: fetchSpy as unknown as typeof fetch,
            });
        } catch (err) {
            expect((err as AdminApiError).status).toBe(409);
            expect((err as AdminApiError).message).toContain("currently signed-in");
        }
    });
});
