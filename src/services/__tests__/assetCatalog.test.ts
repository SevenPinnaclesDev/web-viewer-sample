/*
 * assetCatalog service tests — exercise GET /assets via a stub fetch,
 * cover happy path + malformed payloads + non-2xx + transport error.
 *
 * Ryan Takeda — Asset Browser sprint, 2026-05-02.
 */
import { describe, it, expect, vi } from "vitest";
import {
    listAssets,
    buildAssetListUrl,
    AssetCatalogError,
    type AssetSummary,
} from "../assetCatalog";


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

function sampleAsset(overrides: Partial<AssetSummary> = {}): AssetSummary {
    return {
        asset_id: "compass_step",
        slug: "compass_step",
        current_version: 3,
        omniverse_url: "omniverse://nucleus.dasb256/DATE/assets/compass_step/v3/scene.usd",
        source_format: "step",
        ingest_at: "2026-05-02T19:00:00+00:00",
        thumbnail_url: null,
        ...overrides,
    };
}


// ---- buildAssetListUrl ---------------------------------------------------

describe("buildAssetListUrl", () => {
    it("returns base /assets with no params when opts empty", () => {
        expect(buildAssetListUrl("https://ingest.test")).toBe("https://ingest.test/assets");
    });

    it("strips trailing slash from base", () => {
        expect(buildAssetListUrl("https://ingest.test/")).toBe("https://ingest.test/assets");
    });

    it("appends limit query param", () => {
        expect(buildAssetListUrl("https://ingest.test", { limit: 50 }))
            .toBe("https://ingest.test/assets?limit=50");
    });

    it("appends prefix query param", () => {
        expect(buildAssetListUrl("https://ingest.test", { prefix: "comp" }))
            .toBe("https://ingest.test/assets?prefix=comp");
    });

    it("appends both limit + prefix when both provided", () => {
        const url = buildAssetListUrl("https://ingest.test", { limit: 10, prefix: "comp" });
        expect(url).toContain("limit=10");
        expect(url).toContain("prefix=comp");
        expect(url.startsWith("https://ingest.test/assets?")).toBe(true);
    });

    it("omits empty prefix from query string", () => {
        expect(buildAssetListUrl("https://ingest.test", { prefix: "" }))
            .toBe("https://ingest.test/assets");
    });

    it("omits non-positive limit from query string", () => {
        expect(buildAssetListUrl("https://ingest.test", { limit: 0 }))
            .toBe("https://ingest.test/assets");
    });
});


// ---- listAssets ----------------------------------------------------------

describe("listAssets", () => {
    it("returns parsed AssetSummary[] on 200 OK with a valid array body", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            sampleAsset({ slug: "compass_step" }),
            sampleAsset({ slug: "engine_block_step", current_version: 1 }),
        ]));
        const out = await listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out).toHaveLength(2);
        expect(out[0].slug).toBe("compass_step");
        expect(out[1].slug).toBe("engine_block_step");
        expect(out[1].current_version).toBe(1);
        expect(fetchSpy).toHaveBeenCalledWith(
            "https://ingest.test/assets",
            expect.objectContaining({ method: "GET" }),
        );
    });

    it("forwards limit + prefix query params to fetch", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        await listAssets("https://ingest.test", {
            fetchFn: fetchSpy as unknown as typeof fetch,
            limit: 25,
            prefix: "comp",
        });
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain("limit=25");
        expect(calledUrl).toContain("prefix=comp");
    });

    it("returns [] for an empty 200 OK array (empty-catalog state)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        const out = await listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out).toEqual([]);
    });

    it("drops malformed rows missing slug or omniverse_url, keeps valid ones", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            sampleAsset({ slug: "ok" }),
            { asset_id: "no_slug", omniverse_url: "omniverse://x" },          // no slug → drop
            { asset_id: "no_url", slug: "no_url" },                            // no omniverse_url → drop
            sampleAsset({ slug: "also_ok" }),
        ]));
        const out = await listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out.map((a) => a.slug)).toEqual(["ok", "also_ok"]);
    });

    it("coerces stringy current_version to number, defaults to 1 when missing", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            { slug: "a", omniverse_url: "omniverse://x", current_version: "5" },
            { slug: "b", omniverse_url: "omniverse://y" /* no version */ },
        ]));
        const out = await listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch });
        expect(out[0].current_version).toBe(5);
        expect(out[1].current_version).toBe(1);
    });

    it("throws AssetCatalogError with HTTP status on non-2xx", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "boom" }, 503));
        await expect(listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toThrow(AssetCatalogError);
        try {
            await listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch });
        } catch (err) {
            expect(err).toBeInstanceOf(AssetCatalogError);
            expect((err as AssetCatalogError).status).toBe(503);
        }
    });

    it("throws AssetCatalogError with status=-1 on transport failure", async () => {
        const fetchSpy = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
        await expect(listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toThrow(AssetCatalogError);
        try {
            await listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch });
        } catch (err) {
            expect((err as AssetCatalogError).status).toBe(-1);
            expect((err as AssetCatalogError).message).toContain("Failed to fetch");
        }
    });

    it("throws AssetCatalogError when response body is not an array", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse({ detail: "not array" }, 200));
        await expect(listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toThrow(/expected array/);
    });

    it("re-throws AbortError unchanged so callers can distinguish cancellation", async () => {
        const abortErr = new Error("aborted");
        abortErr.name = "AbortError";
        const fetchSpy = vi.fn().mockRejectedValue(abortErr);
        await expect(listAssets("https://ingest.test", { fetchFn: fetchSpy as unknown as typeof fetch }))
            .rejects.toBe(abortErr);
    });
});
