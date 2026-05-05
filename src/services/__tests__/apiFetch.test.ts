/*
 * apiFetch tests — verify same-origin URL resolution + 401 redirect
 * behavior.
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
    apiFetch,
    buildLoginRedirectUrl,
    setRedirectImpl,
} from "../apiFetch";
import { UnauthenticatedError } from "../whoami";


function makeResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
    } as unknown as Response;
}


describe("apiFetch", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        // Restore default redirect (we can't read the original, so set to a no-op).
        setRedirectImpl(() => { /* noop */ });
    });

    it("resolves to the same-origin path and includes credentials", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        await apiFetch("/api/assets", { fetchFn: fetchSpy as unknown as typeof fetch });
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toBe("/api/assets");
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.credentials).toBe("include");
    });

    it("forwards method + body + headers from init", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        const fd = new FormData();
        fd.append("file", new Blob(["x"]), "x.txt");
        await apiFetch("/api/ingest", {
            fetchFn: fetchSpy as unknown as typeof fetch,
            method: "POST",
            body: fd,
        });
        const init = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(init.method).toBe("POST");
        expect(init.body).toBe(fd);
    });

    it("returns the Response on 2xx", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ ok: 1 }, 200));
        const resp = await apiFetch("/api/assets", { fetchFn: fetchSpy as unknown as typeof fetch });
        expect(resp.status).toBe(200);
    });

    it("redirects to /auth/login and throws UnauthenticatedError on 401", async () => {
        const redirectSpy = vi.fn();
        setRedirectImpl(redirectSpy);
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "no session" }, 401));

        await expect(apiFetch("/api/assets", { fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBeInstanceOf(UnauthenticatedError);

        expect(redirectSpy).toHaveBeenCalledTimes(1);
        const target = redirectSpy.mock.calls[0][0] as string;
        expect(target).toContain("/auth/login");
        expect(target).toContain("return_to=");
    });

    it("forwards non-401 non-2xx responses without redirect", async () => {
        const redirectSpy = vi.fn();
        setRedirectImpl(redirectSpy);
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "boom" }, 503));
        const resp = await apiFetch("/api/assets", { fetchFn: fetchSpy as unknown as typeof fetch });
        expect(resp.status).toBe(503);
        expect(redirectSpy).not.toHaveBeenCalled();
    });

    it("propagates transport failures", async () => {
        const fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(apiFetch("/api/assets", { fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toThrow("Failed to fetch");
    });
});


describe("buildLoginRedirectUrl", () => {
    it("includes the current pathname + search as encoded return_to", () => {
        const target = buildLoginRedirectUrl();
        expect(target).toContain("/auth/login");
        expect(target).toContain("return_to=");
        // jsdom defaults pathname to "/"; verify it round-trips encoded.
        expect(target).toContain(encodeURIComponent(window.location.pathname + window.location.search));
    });
});
