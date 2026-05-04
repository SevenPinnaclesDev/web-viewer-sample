/*
 * SwatchPanel component test — verifies the panel:
 *   - Renders disconnected state with no channel
 *   - Renders no-asset state with channel but no asset
 *   - On Refresh, fires queryMaterialSlots and renders the result
 *   - Surfaces channel errors as an error banner
 *
 * The InputChannel is mocked at the boundary — we hand the panel a
 * stub that satisfies the surface (queryMaterialSlots / onEvent), so
 * we're not exercising the underlying transport.
 *
 * Ryan Takeda — Phase 1 Day 1, 2026-05-01.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SwatchPanel } from "../SwatchPanel";
import { ChannelError } from "../../../services/inputChannel";
import type {
    LibraryCatalog,
    QuerySlotsResult,
    SetOverridesBulkResult,
} from "../../../services/inputChannelTypes";

function makeMockChannel(overrides: Partial<{
    queryMaterialSlots: (id: string) => Promise<QuerySlotsResult>;
    onEvent: (e: string, h: unknown) => () => void;
    listLibraryMaterials: () => Promise<LibraryCatalog>;
    setMaterialOverride: (a: string, s: string, m: string) => Promise<{}>;
    setMaterialOverridesBulk: (a: string, s: string[], m: string) => Promise<SetOverridesBulkResult>;
}> = {}) {
    const onEvent = overrides.onEvent ?? vi.fn(() => () => {});
    const queryMaterialSlots = overrides.queryMaterialSlots ?? vi.fn();
    const listLibraryMaterials = overrides.listLibraryMaterials ?? vi.fn();
    const setMaterialOverride = overrides.setMaterialOverride ?? vi.fn().mockResolvedValue({});
    const setMaterialOverridesBulk = overrides.setMaterialOverridesBulk
        ?? vi.fn().mockResolvedValue({ applied: [], skipped: [] });
    // Cast to `any` then to InputChannel — we deliberately don't satisfy
    // the entire class (we only use what SwatchPanel reaches for).
    return {
        queryMaterialSlots,
        onEvent,
        listLibraryMaterials,
        setMaterialOverride,
        setMaterialOverridesBulk,
    } as any;
}

const sampleCatalog: LibraryCatalog = {
    library_version: "2026-05-02",
    categories: [
        {
            path: "Metals",
            display_name: "Metals",
            materials: [
                {
                    filename: "Aluminum_Brushed.mdl",
                    display_name: "Brushed Aluminum",
                    tags: ["metal"],
                    thumbnail: "Aluminum_Brushed.png",
                    author: "Elena",
                    author_date: "2026-05-15",
                },
            ],
        },
    ],
};

const sampleSlotsResult: QuerySlotsResult = {
    asset_id: "compass_step",
    slots: [
        {
            slot_id: "Diffuse@compass_step",
            source_name: "Diffuse",
            display_name: "Body227",
            placeholder_color: [1.0, 0.63, 0.0],
            bound_prim_count: 7,
            bound_body_names: ["Body227"],
            is_overridden: false,
            current_mdl_path: null,
        },
        {
            slot_id: "Diffuse_1@compass_step",
            source_name: "Diffuse_1",
            display_name: "Body14141",
            placeholder_color: [0.165, 0.298, 0.192],
            bound_prim_count: 1,
            bound_body_names: ["Body14141"],
            is_overridden: false,
            current_mdl_path: null,
        },
    ],
};

describe("SwatchPanel", () => {
    it("renders disconnected state when channel is null", () => {
        render(<SwatchPanel channel={null} assetId="x" />);
        expect(screen.getByTestId("swatch-panel-disconnected")).toBeInTheDocument();
    });

    it("renders no-asset state when assetId is null", () => {
        const ch = makeMockChannel();
        render(<SwatchPanel channel={ch} assetId={null} />);
        expect(screen.getByTestId("swatch-panel-no-asset")).toBeInTheDocument();
    });

    it("renders idle state with Refresh button when channel + asset present", () => {
        const ch = makeMockChannel();
        render(<SwatchPanel channel={ch} assetId="compass_step" />);
        expect(screen.getByTestId("swatch-panel-idle")).toBeInTheDocument();
        expect(screen.getByTestId("swatch-panel-refresh")).toBeInTheDocument();
    });

    it("Refresh fires queryMaterialSlots and renders the slot list", async () => {
        const result: QuerySlotsResult = {
            asset_id: "compass_step",
            slots: [
                {
                    slot_id: "Diffuse@compass_step",
                    source_name: "Diffuse",
                    display_name: "Body227",
                    placeholder_color: [1.0, 0.63, 0.0],
                    bound_prim_count: 7,
                    bound_body_names: ["Body227"],
                    is_overridden: false,
                    current_mdl_path: null,
                },
            ],
        };
        const queryMaterialSlots = vi.fn().mockResolvedValue(result);
        const ch = makeMockChannel({ queryMaterialSlots });
        render(<SwatchPanel channel={ch} assetId="compass_step" />);

        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        expect(queryMaterialSlots).toHaveBeenCalledWith("compass_step");

        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());
        expect(screen.getByText("Body227")).toBeInTheDocument();
    });

    it("acceptance criterion 6: empty result renders SlotList with empty-state", async () => {
        const queryMaterialSlots = vi.fn().mockResolvedValue({
            asset_id: "empty",
            slots: [],
        });
        const ch = makeMockChannel({ queryMaterialSlots });
        render(<SwatchPanel channel={ch} assetId="empty" />);
        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());
        expect(screen.getByTestId("slot-list-empty")).toHaveTextContent(/No materials/i);
    });

    it("surfaces ChannelError as an error banner with code + message", async () => {
        const queryMaterialSlots = vi.fn().mockRejectedValue(
            new ChannelError("asset_not_open", "no asset is currently open"),
        );
        const ch = makeMockChannel({ queryMaterialSlots });
        render(<SwatchPanel channel={ch} assetId="compass_step" />);
        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("swatch-panel-error")).toBeInTheDocument());
        expect(screen.getByText("asset_not_open")).toBeInTheDocument();
        expect(screen.getByText("no asset is currently open")).toBeInTheDocument();
    });

    it("subscribes to asset.opened on mount", () => {
        const onEvent = vi.fn(() => () => {});
        const ch = makeMockChannel({ onEvent });
        render(<SwatchPanel channel={ch} assetId="compass_step" />);
        expect(onEvent).toHaveBeenCalledWith("asset.opened", expect.any(Function));
    });

    it("clicking a slot row opens the picker for that single slot", async () => {
        const queryMaterialSlots = vi.fn().mockResolvedValue(sampleSlotsResult);
        const listLibraryMaterials = vi.fn().mockResolvedValue(sampleCatalog);
        const ch = makeMockChannel({ queryMaterialSlots, listLibraryMaterials });
        render(<SwatchPanel channel={ch} assetId="compass_step" libraryRootUrl="omniverse://test/Lib" />);

        // Load slots
        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());

        // Click first slot row
        const rows = screen.getAllByTestId("slot-row");
        fireEvent.click(rows[0]);

        // Picker is open with single-slot header
        await waitFor(() => expect(screen.getByTestId("mdl-picker-overlay")).toBeInTheDocument());
        const header = screen.getByTestId("mdl-picker-header-single");
        expect(header).toHaveTextContent("Body227");

        // Library was fetched
        expect(listLibraryMaterials).toHaveBeenCalledTimes(1);
    });

    it("clicking an MDL card fires material.set_override and shows the applied toast", async () => {
        const queryMaterialSlots = vi.fn().mockResolvedValue(sampleSlotsResult);
        const listLibraryMaterials = vi.fn().mockResolvedValue(sampleCatalog);
        const setMaterialOverride = vi.fn().mockResolvedValue({});
        const ch = makeMockChannel({
            queryMaterialSlots,
            listLibraryMaterials,
            setMaterialOverride,
        });
        render(<SwatchPanel channel={ch} assetId="compass_step" libraryRootUrl="omniverse://test/Lib" />);

        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());

        fireEvent.click(screen.getAllByTestId("slot-row")[0]);
        await waitFor(() => expect(screen.getByTestId("mdl-picker-overlay")).toBeInTheDocument());

        // Wait for catalog to render in the picker
        await waitFor(() => expect(screen.getByTestId("mdl-picker-card")).toBeInTheDocument());

        fireEvent.click(screen.getByTestId("mdl-picker-card"));

        // Picker closes
        await waitFor(() => expect(screen.queryByTestId("mdl-picker-overlay")).not.toBeInTheDocument());

        // material.set_override was called with the right args
        expect(setMaterialOverride).toHaveBeenCalledWith(
            "compass_step",
            "Diffuse@compass_step",
            "omniverse://test/Lib/Metals/Aluminum_Brushed.mdl",
        );

        // Applied toast renders
        await waitFor(() => expect(screen.getByTestId("swatch-panel-toast-applied")).toBeInTheDocument());
        expect(screen.getByTestId("swatch-panel-toast-applied")).toHaveTextContent("Brushed Aluminum");
    });

    it("multi-select + bulk-pick fires set_overrides_bulk for all selected slots", async () => {
        const queryMaterialSlots = vi.fn().mockResolvedValue(sampleSlotsResult);
        const listLibraryMaterials = vi.fn().mockResolvedValue(sampleCatalog);
        const setMaterialOverridesBulk = vi.fn().mockResolvedValue({
            applied: ["Diffuse@compass_step", "Diffuse_1@compass_step"],
            skipped: [],
        });
        const ch = makeMockChannel({
            queryMaterialSlots,
            listLibraryMaterials,
            setMaterialOverridesBulk,
        });
        render(<SwatchPanel channel={ch} assetId="compass_step" libraryRootUrl="omniverse://test/Lib" />);

        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());

        // Tick both checkboxes
        const checks = screen.getAllByTestId("slot-row-check");
        fireEvent.click(checks[0]);
        fireEvent.click(checks[1]);

        // Bulk-pick button appears in header
        const bulkBtn = await screen.findByTestId("swatch-panel-bulk-pick");
        expect(bulkBtn).toHaveTextContent(/2 selected/);
        fireEvent.click(bulkBtn);

        // Picker opens with bulk header
        await waitFor(() => expect(screen.getByTestId("mdl-picker-header-bulk")).toBeInTheDocument());

        await waitFor(() => expect(screen.getByTestId("mdl-picker-card")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("mdl-picker-card"));

        // Picker closes, set_overrides_bulk called with both slot ids
        await waitFor(() =>
            expect(setMaterialOverridesBulk).toHaveBeenCalledWith(
                "compass_step",
                ["Diffuse@compass_step", "Diffuse_1@compass_step"],
                "omniverse://test/Lib/Metals/Aluminum_Brushed.mdl",
            ),
        );

        await waitFor(() => expect(screen.getByTestId("swatch-panel-toast-applied")).toBeInTheDocument());
    });

    it("apply failure surfaces as a failed toast with the channel error", async () => {
        const queryMaterialSlots = vi.fn().mockResolvedValue(sampleSlotsResult);
        const listLibraryMaterials = vi.fn().mockResolvedValue(sampleCatalog);
        const setMaterialOverride = vi.fn().mockRejectedValue(
            new ChannelError("slot_not_found", "no Material prims match"),
        );
        const ch = makeMockChannel({
            queryMaterialSlots, listLibraryMaterials, setMaterialOverride,
        });
        render(<SwatchPanel channel={ch} assetId="compass_step" libraryRootUrl="omniverse://test/Lib" />);

        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());
        fireEvent.click(screen.getAllByTestId("slot-row")[0]);
        await waitFor(() => expect(screen.getByTestId("mdl-picker-card")).toBeInTheDocument());
        fireEvent.click(screen.getByTestId("mdl-picker-card"));

        await waitFor(() => expect(screen.getByTestId("swatch-panel-toast-failed")).toBeInTheDocument());
        expect(screen.getByTestId("swatch-panel-toast-failed")).toHaveTextContent(/slot_not_found/);
    });

    it("library fetch error surfaces in picker error state with retry", async () => {
        const queryMaterialSlots = vi.fn().mockResolvedValue(sampleSlotsResult);
        const listLibraryMaterials = vi.fn().mockRejectedValueOnce(
            new ChannelError("library_not_found", "catalog missing on Nucleus"),
        ).mockResolvedValueOnce(sampleCatalog);
        const ch = makeMockChannel({ queryMaterialSlots, listLibraryMaterials });
        render(<SwatchPanel channel={ch} assetId="compass_step" />);

        fireEvent.click(screen.getByTestId("swatch-panel-refresh"));
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());
        fireEvent.click(screen.getAllByTestId("slot-row")[0]);

        // First fetch failed → picker error
        await waitFor(() => expect(screen.getByTestId("mdl-picker-error")).toBeInTheDocument());
        expect(screen.getByText(/library_not_found/)).toBeInTheDocument();

        // Retry → second fetch resolves with catalog
        fireEvent.click(screen.getByTestId("mdl-picker-retry"));
        await waitFor(() => expect(screen.getByTestId("mdl-picker-card")).toBeInTheDocument());
    });

    it("Day 2 acceptance criterion 3: asset.opened auto-fires queryMaterialSlots", async () => {
        // Capture the asset.opened handler the panel registers, then invoke
        // it as the channel would. queryMaterialSlots should be called and
        // the panel should render the slot list without a manual button click.
        let openedHandler: ((evt: { event: string; payload: unknown }) => void) | null = null;
        const onEvent = vi.fn((name: string, handler: unknown) => {
            if (name === "asset.opened") {
                openedHandler = handler as (e: { event: string; payload: unknown }) => void;
            }
            return () => {};
        });
        const result: QuerySlotsResult = {
            asset_id: "compass_step",
            slots: [{
                slot_id: "Diffuse@compass_step",
                source_name: "Diffuse",
                display_name: "Body227",
                placeholder_color: [1.0, 0.63, 0.0],
                bound_prim_count: 7,
                bound_body_names: ["Body227"],
                is_overridden: false,
                current_mdl_path: null,
            }],
        };
        const queryMaterialSlots = vi.fn().mockResolvedValue(result);
        const ch = makeMockChannel({ onEvent, queryMaterialSlots });
        render(<SwatchPanel channel={ch} assetId="compass_step" />);

        // Pre-condition: idle, no slots rendered yet.
        expect(screen.getByTestId("swatch-panel-idle")).toBeInTheDocument();
        expect(queryMaterialSlots).not.toHaveBeenCalled();

        // Server emits asset.opened — simulate by invoking the registered handler.
        expect(openedHandler).not.toBeNull();
        openedHandler!({
            event: "asset.opened",
            payload: { asset_id: "compass_step", loaded_at: "2026-05-01T19:00:00+00:00" },
        });

        // queryMaterialSlots gets called for the open asset, slot list renders.
        expect(queryMaterialSlots).toHaveBeenCalledWith("compass_step");
        await waitFor(() => expect(screen.getByTestId("slot-list")).toBeInTheDocument());
        expect(screen.getByText("Body227")).toBeInTheDocument();
    });
});
