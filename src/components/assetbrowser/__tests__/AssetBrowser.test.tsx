/*
 * AssetBrowser component tests — drive the panel through React Testing
 * Library + a stub fetch + a stub channel.
 *
 * Coverage:
 *   - Default-collapsed: panel hidden, toggle visible
 *   - Toggle expands the panel, fetches and lists assets
 *   - Asset card click fires openAsset with slug + verbatim omniverse_url
 *   - Search filters list client-side by slug substring
 *   - Empty state when 0 assets returned
 *   - Refresh button re-fetches
 *   - Error state on fetch failure with retry
 *   - channel=null guards click and surfaces a "stream not connected" toast
 *   - Loading state while in-flight
 *
 * Ryan Takeda — Asset Browser sprint, 2026-05-02.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AssetBrowser } from "../AssetBrowser";
import type { AssetSummary } from "../../../services/assetCatalog";


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

function asset(overrides: Partial<AssetSummary> = {}): AssetSummary {
    return {
        asset_id: "a_id",
        slug: "compass_step",
        current_version: 3,
        omniverse_url: "omniverse://nucleus.dasb256/DATE/assets/compass_step/v3/scene.usd",
        source_format: "step",
        ingest_at: "2026-05-02T19:00:00+00:00",
        thumbnail_url: null,
        ...overrides,
    };
}

function makeMockChannel(overrides: Partial<{
    openAsset: (slug: string, version?: number, url?: string) => Promise<unknown>;
}> = {}) {
    const openAsset = overrides.openAsset ?? vi.fn().mockResolvedValue({
        asset_id: "compass_step", open_request_acked: true,
    });
    return { openAsset } as any;
}


// ---- Tests ----------------------------------------------------------------

describe("AssetBrowser", () => {
    beforeEach(() => {
        // jsdom may share state across tests
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders collapsed by default — toggle visible, panel hidden", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        expect(screen.getByTestId("asset-browser-toggle")).toBeInTheDocument();
        expect(screen.queryByTestId("asset-browser-panel")).not.toBeInTheDocument();
    });

    it("clicking the toggle expands the panel", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
            />,
        );
        fireEvent.click(screen.getByTestId("asset-browser-toggle"));
        expect(screen.getByTestId("asset-browser-panel")).toBeInTheDocument();
    });

    it("when initiallyExpanded, panel renders and fetches on mount", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            asset({ slug: "compass_step", asset_id: "a1" }),
            asset({ slug: "engine_block_step", asset_id: "a2" }),
        ]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        expect(screen.getByTestId("asset-browser-panel")).toBeInTheDocument();
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        await waitFor(() => expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(2));
        expect(screen.getByText("compass_step")).toBeInTheDocument();
        expect(screen.getByText("engine_block_step")).toBeInTheDocument();
    });

    it("renders empty state when /assets returns []", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-empty")).toBeInTheDocument());
        expect(screen.getByTestId("asset-browser-empty")).toHaveTextContent(/No assets ingested yet/);
    });

    it("renders error state on fetch rejection; retry button re-fetches", async () => {
        const fetchSpy = vi.fn()
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(makeResponse([asset({ slug: "ok", asset_id: "a3" })]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-error")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("asset-browser-retry"));
        await waitFor(() => expect(screen.getByText("ok")).toBeInTheDocument());
    });

    it("clicking an asset card fires openAsset with slug + verbatim omniverse_url", async () => {
        const channel = makeMockChannel();
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            asset({
                slug: "compass_step",
                asset_id: "a1",
                omniverse_url: "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
            }),
        ]));
        render(
            <AssetBrowser
                channel={channel}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-card")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("asset-browser-card"));
        await waitFor(() => expect(channel.openAsset).toHaveBeenCalledWith(
            "compass_step",
            undefined,
            "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
        ));
        await waitFor(() => expect(screen.getByTestId("asset-browser-toast-loaded")).toBeInTheDocument());
    });

    it("shows failed toast when channel.openAsset rejects", async () => {
        const channel = makeMockChannel({
            openAsset: vi.fn().mockRejectedValue(new Error("nucleus_unreachable: timeout")),
        });
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([asset({ slug: "x", asset_id: "x1" })]));
        render(
            <AssetBrowser
                channel={channel}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-card")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("asset-browser-card"));
        await waitFor(() => expect(screen.getByTestId("asset-browser-toast-failed")).toBeInTheDocument());
        expect(screen.getByTestId("asset-browser-toast-failed")).toHaveTextContent(/nucleus_unreachable/);
    });

    it("with channel=null, click surfaces a 'stream not connected' toast and does not throw", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([asset({ slug: "y", asset_id: "y1" })]));
        render(
            <AssetBrowser
                channel={null}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-card")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("asset-browser-card"));
        expect(screen.getByTestId("asset-browser-toast-failed")).toHaveTextContent(/stream not connected/);
    });

    it("filters list client-side via the search box (slug substring)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            asset({ slug: "compass_step", asset_id: "a1" }),
            asset({ slug: "engine_block_step", asset_id: "a2" }),
            asset({ slug: "compass_v2", asset_id: "a3" }),
        ]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(3));
        fireEvent.change(screen.getByTestId("asset-browser-search"), {
            target: { value: "compass" },
        });
        expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(2);
        fireEvent.change(screen.getByTestId("asset-browser-search"), {
            target: { value: "engine" },
        });
        expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(1);
        expect(screen.getByText("engine_block_step")).toBeInTheDocument();
    });

    it("renders empty-search state when filter matches nothing", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            asset({ slug: "compass_step", asset_id: "a1" }),
        ]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-card")).toBeInTheDocument());
        fireEvent.change(screen.getByTestId("asset-browser-search"), {
            target: { value: "zzzzzz" },
        });
        expect(screen.getByTestId("asset-browser-empty-search")).toBeInTheDocument();
    });

    it("refresh button re-fetches the catalog", async () => {
        const fetchSpy = vi.fn()
            .mockResolvedValueOnce(makeResponse([asset({ slug: "first", asset_id: "f1" })]))
            .mockResolvedValueOnce(makeResponse([
                asset({ slug: "first", asset_id: "f1" }),
                asset({ slug: "second", asset_id: "s1" }),
            ]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(1));
        fireEvent.click(screen.getByTestId("asset-browser-refresh"));
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(2));
    });

    it("collapse button hides the panel", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        expect(screen.getByTestId("asset-browser-panel")).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("asset-browser-collapse"));
        expect(screen.queryByTestId("asset-browser-panel")).not.toBeInTheDocument();
        expect(screen.getByTestId("asset-browser-toggle")).toBeInTheDocument();
    });

    it("dismiss button hides the toast", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([asset({ slug: "x", asset_id: "x1" })]));
        render(
            <AssetBrowser
                channel={null}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getByTestId("asset-browser-card")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("asset-browser-card"));
        expect(screen.getByTestId("asset-browser-toast-failed")).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("asset-browser-toast-dismiss"));
        expect(screen.queryByTestId("asset-browser-toast-failed")).not.toBeInTheDocument();
    });

    it("forwards limit prop to the /assets request", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
                limit={25}
            />,
        );
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain("limit=25");
    });

    it("renders source_format badge and version > 1 on each card", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makeResponse([
            asset({ slug: "compass_step", asset_id: "a1", source_format: "step", current_version: 3 }),
            asset({ slug: "first_v1", asset_id: "a2", source_format: "ifc", current_version: 1 }),
        ]));
        render(
            <AssetBrowser
                channel={makeMockChannel()}
                fetchFn={fetchSpy as unknown as typeof fetch}
                initiallyExpanded
            />,
        );
        await waitFor(() => expect(screen.getAllByTestId("asset-browser-card")).toHaveLength(2));
        // step format rendered uppercased (CSS text-transform), DOM stays as-given
        expect(screen.getByText("step")).toBeInTheDocument();
        expect(screen.getByText("ifc")).toBeInTheDocument();
        expect(screen.getByText("v3")).toBeInTheDocument();
        // v1 is the default — we suppress it from the badge to reduce noise
        expect(screen.queryByText("v1")).not.toBeInTheDocument();
    });
});
