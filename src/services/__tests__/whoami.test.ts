/*
 * whoami service tests — exercise GET /auth/whoami via a stub fetch,
 * cover happy path, 401 → UnauthenticatedError, other non-2xx, and
 * malformed payloads.
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    getWhoAmI,
    UnauthenticatedError,
    WhoAmIError,
} from "../whoami";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}


describe("getWhoAmI", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("returns User on 200 with a valid body", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            email: "elena@mfo.example",
            role: "admin",
            display_name: "Elena Reyes",
            user_id: "u-1",
        }));
        const user = await getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch });
        expect(user).toEqual({
            email: "elena@mfo.example",
            role: "admin",
            display_name: "Elena Reyes",
            user_id: "u-1",
        });
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain("/auth/whoami");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.credentials).toBe("include");
    });

    it("throws UnauthenticatedError on 401", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "no session" }, 401));
        await expect(getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBeInstanceOf(UnauthenticatedError);
    });

    it("throws WhoAmIError with status on 5xx", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "boom" }, 503));
        try {
            await getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch });
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(WhoAmIError);
            expect((err as WhoAmIError).status).toBe(503);
        }
    });

    it("throws WhoAmIError with status=-1 on transport failure", async () => {
        const fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        try {
            await getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch });
            throw new Error("should have thrown");
        } catch (err) {
            expect(err).toBeInstanceOf(WhoAmIError);
            expect((err as WhoAmIError).status).toBe(-1);
            expect((err as WhoAmIError).message).toContain("Failed to fetch");
        }
    });

    it("throws WhoAmIError when role is invalid", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            email: "x@y.z", role: "owner", display_name: "X",
        }));
        await expect(getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBeInstanceOf(WhoAmIError);
    });

    it("throws WhoAmIError when email is missing", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            role: "user", display_name: "X",
        }));
        await expect(getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBeInstanceOf(WhoAmIError);
    });

    it("re-throws AbortError unchanged", async () => {
        const abortErr = new Error("aborted");
        abortErr.name = "AbortError";
        const fetchSpy = vi.fn().mockRejectedValue(abortErr);
        await expect(getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBe(abortErr);
    });

    it("defaults missing display_name to empty string", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({
            email: "x@y.z", role: "user",
        }));
        const user = await getWhoAmI({ fetchFn: fetchSpy as unknown as typeof fetch });
        expect(user.display_name).toBe("");
    });
});
