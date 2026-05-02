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
import type { QuerySlotsResult } from "../../../services/inputChannelTypes";

function makeMockChannel(overrides: Partial<{
    queryMaterialSlots: (id: string) => Promise<QuerySlotsResult>;
    onEvent: (e: string, h: unknown) => () => void;
}> = {}) {
    const onEvent = overrides.onEvent ?? vi.fn(() => () => {});
    const queryMaterialSlots = overrides.queryMaterialSlots ?? vi.fn();
    // Cast to `any` then to InputChannel — we deliberately don't satisfy
    // the entire class (we only use what SwatchPanel reaches for).
    return { queryMaterialSlots, onEvent } as any;
}

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
