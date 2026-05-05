/*
 * apiBase tests — same-origin URL resolution helpers.
 *
 * Ryan Takeda — same-origin refactor, 2026-05-04.
 */
import { describe, it, expect, afterEach } from "vitest";
import { apiBase, apiUrl, wsUrl, setApiBaseOverride } from "../apiBase";


afterEach(() => {
    setApiBaseOverride(undefined);
});


describe("apiBase", () => {
    it("returns empty string when no override (same-origin default)", () => {
        setApiBaseOverride("");
        expect(apiBase()).toBe("");
    });

    it("returns the override when set", () => {
        setApiBaseOverride("https://staging.example");
        expect(apiBase()).toBe("https://staging.example");
    });

    it("strips trailing slash from override", () => {
        setApiBaseOverride("https://staging.example/");
        expect(apiBase()).toBe("https://staging.example");
    });
});


describe("apiUrl", () => {
    it("prepends a leading slash when missing (same-origin default)", () => {
        setApiBaseOverride("");
        expect(apiUrl("api/assets")).toBe("/api/assets");
    });

    it("preserves leading slash when present (same-origin default)", () => {
        setApiBaseOverride("");
        expect(apiUrl("/api/assets")).toBe("/api/assets");
    });

    it("joins env override + path", () => {
        setApiBaseOverride("https://staging.example");
        expect(apiUrl("/api/assets")).toBe("https://staging.example/api/assets");
        expect(apiUrl("api/assets")).toBe("https://staging.example/api/assets");
    });
});


describe("wsUrl", () => {
    it("builds wss:// or ws:// from same-origin window.location", () => {
        setApiBaseOverride("");
        const url = wsUrl("/api/ingest/ws/abc");
        // jsdom's default origin yields ws:// for http:; the function
        // must produce ws:// for http origins, wss:// for https origins.
        expect(url).toMatch(/^wss?:\/\//);
        expect(url).toContain("/api/ingest/ws/abc");
    });

    it("converts https env override to wss://", () => {
        setApiBaseOverride("https://staging.example");
        expect(wsUrl("/api/ingest/ws/abc")).toBe("wss://staging.example/api/ingest/ws/abc");
    });

    it("converts http env override to ws://", () => {
        setApiBaseOverride("http://staging.example");
        expect(wsUrl("/api/ingest/ws/abc")).toBe("ws://staging.example/api/ingest/ws/abc");
    });

    it("normalizes paths missing a leading slash", () => {
        setApiBaseOverride("https://staging.example");
        expect(wsUrl("api/ingest/ws/abc")).toBe("wss://staging.example/api/ingest/ws/abc");
    });
});
