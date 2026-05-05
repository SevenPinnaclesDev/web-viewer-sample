/*
 * ViewportPickHandler component tests — tap-to-pick on the streamed viewport.
 *
 * Coverage:
 *   - Disabled toggle when channel/assetId not ready
 *   - Toggle button on/off shows/hides overlay
 *   - Overlay click fires pickSlot with normalized [0..1] coords
 *   - Cmd/Ctrl-click on the wrapper fires pickSlot regardless of toggle
 *   - Picker opens with the slot from a successful pick
 *   - Apply path wires through setMaterialOverride
 *   - Error UX: no_hit silent, no_material toast, others show error toast
 *   - Esc exits pick mode
 *   - computeNormalizedCoords helper edge cases
 *
 * The InputChannel is mocked — we hand the component a stub that satisfies
 * just the surface ViewportPickHandler reaches for (pickSlot,
 * listLibraryMaterials, setMaterialOverride). React-testing-library
 * cleanup happens in __tests__/setup.ts (afterEach autoclean).
 *
 * Ryan Takeda — Phase 1 picker sprint follow-up, 2026-05-04.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
    ViewportPickHandler,
    clampMenuPosition,
    computeNormalizedCoords,
} from "../ViewportPickHandler";
import { ChannelError } from "../../../services/inputChannel";
import type {
    LibraryCatalog,
    PickSlotResult,
} from "../../../services/inputChannelTypes";

function makeMockChannel(overrides: Partial<{
    pickSlot: (x: number, y: number, vp?: string) => Promise<PickSlotResult>;
    listLibraryMaterials: () => Promise<LibraryCatalog>;
    setMaterialOverride: (a: string, s: string, m: string) => Promise<{}>;
    onEvent: (e: string, h: unknown) => () => void;
}> = {}) {
    return {
        pickSlot: overrides.pickSlot ?? vi.fn(),
        listLibraryMaterials: overrides.listLibraryMaterials ?? vi.fn().mockResolvedValue({
            library_version: "test",
            categories: [],
        } as LibraryCatalog),
        setMaterialOverride: overrides.setMaterialOverride ?? vi.fn().mockResolvedValue({}),
        onEvent: overrides.onEvent ?? vi.fn(() => () => {}),
    } as any;
}

const sampleSlot: PickSlotResult = {
    slot_id: "Body_09@compass_step",
    source_name: "Body_09",
    display_name: "Body_09",
    placeholder_color: [0.494, 0.494, 0.494],
    bound_prim_count: 12,
    bound_body_names: ["Body227"],
    is_overridden: false,
    current_mdl_path: null,
    prim_path_picked: "/World/Compass/Body_09_Geom/Mesh",
};

/** Mock getBoundingClientRect on a wrapper-like ref so coord normalization
 *  has predictable input. */
function makeRefWithRect(rect: { left: number; top: number; width: number; height: number }) {
    const div = document.createElement("div");
    div.getBoundingClientRect = () => ({
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
        toJSON: () => "",
    });
    return { current: div } as React.RefObject<HTMLDivElement>;
}

describe("ViewportPickHandler", () => {
    it("renders the toggle button disabled when channel is null", () => {
        render(<ViewportPickHandler channel={null} assetId="x" />);
        const toggle = screen.getByTestId("viewport-pick-toggle");
        expect(toggle).toBeDisabled();
    });

    it("renders the toggle button disabled when assetId is null", () => {
        const ch = makeMockChannel();
        render(<ViewportPickHandler channel={ch} assetId={null} />);
        expect(screen.getByTestId("viewport-pick-toggle")).toBeDisabled();
    });

    it("toggle button enables and toggles the overlay", () => {
        const ch = makeMockChannel();
        render(<ViewportPickHandler channel={ch} assetId="compass_step" />);
        const toggle = screen.getByTestId("viewport-pick-toggle");
        expect(toggle).toBeEnabled();
        // Off by default — no overlay rendered.
        expect(screen.queryByTestId("viewport-pick-overlay")).not.toBeInTheDocument();
        // Click to enable.
        fireEvent.click(toggle);
        expect(screen.getByTestId("viewport-pick-overlay")).toBeInTheDocument();
        expect(toggle).toHaveAttribute("aria-pressed", "true");
        // Click again to disable.
        fireEvent.click(toggle);
        expect(screen.queryByTestId("viewport-pick-overlay")).not.toBeInTheDocument();
    });

    it("clicking the overlay fires pickSlot with normalized coords", async () => {
        const pickSlot = vi.fn().mockResolvedValue(sampleSlot);
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        const overlay = screen.getByTestId("viewport-pick-overlay");
        // pointerDown at (250, 600) → normalized (0.25, 0.75).
        fireEvent.click(overlay, { clientX: 250, clientY: 600, button: 0 });
        await waitFor(() => expect(pickSlot).toHaveBeenCalledTimes(1));
        const [x, y] = pickSlot.mock.calls[0];
        expect(x).toBeCloseTo(0.25, 5);
        expect(y).toBeCloseTo(0.75, 5);
    });

    it("Cmd-click on the wrapper fires pickSlot even when toggle is OFF", async () => {
        const pickSlot = vi.fn().mockResolvedValue(sampleSlot);
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        // Don't enable pick mode — just Cmd-click.
        // Dispatch on document.body so it bubbles to the window-level listener.
        await act(async () => {
            const evt = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                metaKey: true,
                button: 0,
                clientX: 500,
                clientY: 400,
            });
            document.body.dispatchEvent(evt);
        });
        await waitFor(() => expect(pickSlot).toHaveBeenCalledTimes(1));
        const [x, y] = pickSlot.mock.calls[0];
        expect(x).toBeCloseTo(0.5, 5);
        expect(y).toBeCloseTo(0.5, 5);
    });

    it("Ctrl-click on the wrapper fires pickSlot (Linux/PC alternative to Cmd)", async () => {
        const pickSlot = vi.fn().mockResolvedValue(sampleSlot);
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 800, height: 600 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        await act(async () => {
            const evt = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                ctrlKey: true,
                button: 0,
                clientX: 400,
                clientY: 300,
            });
            document.body.dispatchEvent(evt);
        });
        await waitFor(() => expect(pickSlot).toHaveBeenCalledTimes(1));
    });

    it("Cmd-click outside the wrapper rect does NOT fire pickSlot", async () => {
        const pickSlot = vi.fn().mockResolvedValue(sampleSlot);
        const ch = makeMockChannel({ pickSlot });
        // Wrapper is 100..500, 100..500. Click at (50, 50) is outside.
        const ref = makeRefWithRect({ left: 100, top: 100, width: 400, height: 400 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        await act(async () => {
            const evt = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                metaKey: true,
                button: 0,
                clientX: 50,
                clientY: 50,
            });
            document.body.dispatchEvent(evt);
        });
        // Give the handler a moment to potentially fire (it shouldn't).
        await new Promise((r) => setTimeout(r, 5));
        expect(pickSlot).not.toHaveBeenCalled();
    });

    it("simple click WITHOUT modifier does NOT fire pickSlot in non-pick mode", async () => {
        const pickSlot = vi.fn().mockResolvedValue(sampleSlot);
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        await act(async () => {
            const evt = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                button: 0,
                clientX: 500,
                clientY: 400,
            });
            document.body.dispatchEvent(evt);
        });
        await new Promise((r) => setTimeout(r, 5));
        expect(pickSlot).not.toHaveBeenCalled();
    });

    it("successful pick opens the action menu (not the picker directly)", async () => {
        // Visibility primitives sprint (2026-05-02 follow-up): the pick
        // flow now goes pick → action menu → "Pick Material" → picker
        // modal. The action menu carries Hide / Isolate / Pick Material /
        // Focus, so the operator chooses what to do. The picker only
        // opens after the operator clicks "Pick Material" inside the menu.
        const pickSlot = vi.fn().mockResolvedValue(sampleSlot);
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        fireEvent.click(screen.getByTestId("viewport-pick-overlay"), {
            clientX: 500, clientY: 400, button: 0,
        });
        // Action menu appears with the slot's display_name as the header.
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-action-menu")).toBeInTheDocument();
        });
        // All four action buttons rendered.
        expect(screen.getByTestId("viewport-pick-action-hide")).toBeInTheDocument();
        expect(screen.getByTestId("viewport-pick-action-isolate")).toBeInTheDocument();
        expect(screen.getByTestId("viewport-pick-action-pick-material")).toBeInTheDocument();
        expect(screen.getByTestId("viewport-pick-action-focus")).toBeInTheDocument();
    });

    it("no_hit error is silently ignored (no toast)", async () => {
        const pickSlot = vi.fn().mockRejectedValue(new ChannelError("no_hit", "ray missed"));
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        fireEvent.click(screen.getByTestId("viewport-pick-overlay"), {
            clientX: 500, clientY: 400, button: 0,
        });
        await waitFor(() => expect(pickSlot).toHaveBeenCalled());
        // No toast should appear.
        await new Promise((r) => setTimeout(r, 10));
        expect(screen.queryByTestId("viewport-pick-toast-info")).not.toBeInTheDocument();
        expect(screen.queryByTestId("viewport-pick-toast-failed")).not.toBeInTheDocument();
    });

    it("no_material error shows an info toast", async () => {
        const pickSlot = vi.fn().mockRejectedValue(
            new ChannelError("no_material", "no shader on prim"),
        );
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        fireEvent.click(screen.getByTestId("viewport-pick-overlay"), {
            clientX: 500, clientY: 400, button: 0,
        });
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-toast-info")).toBeInTheDocument();
        });
        expect(screen.getByTestId("viewport-pick-toast-info").textContent ?? "").toMatch(
            /Composer/i,
        );
    });

    it("other errors show a failed toast with code+message", async () => {
        const pickSlot = vi.fn().mockRejectedValue(
            new ChannelError("kit_internal", "something broke"),
        );
        const ch = makeMockChannel({ pickSlot });
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        render(<ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />);
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        fireEvent.click(screen.getByTestId("viewport-pick-overlay"), {
            clientX: 500, clientY: 400, button: 0,
        });
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-toast-failed")).toBeInTheDocument();
        });
        expect(screen.getByTestId("viewport-pick-toast-failed").textContent ?? "").toContain(
            "kit_internal",
        );
    });

    it("Esc exits pick mode (toggle returns to off)", async () => {
        const ch = makeMockChannel();
        render(<ViewportPickHandler channel={ch} assetId="compass_step" />);
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        expect(screen.getByTestId("viewport-pick-overlay")).toBeInTheDocument();
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(screen.queryByTestId("viewport-pick-overlay")).not.toBeInTheDocument();
    });

    it("computeNormalizedCoords returns null for clicks outside the rect", () => {
        const rect = { left: 100, top: 100, width: 400, height: 400 };
        // Inside.
        expect(computeNormalizedCoords(300, 300, rect)).toEqual({ xNorm: 0.5, yNorm: 0.5 });
        // Outside left.
        expect(computeNormalizedCoords(50, 300, rect)).toBeNull();
        // Outside top.
        expect(computeNormalizedCoords(300, 50, rect)).toBeNull();
        // Outside right.
        expect(computeNormalizedCoords(600, 300, rect)).toBeNull();
        // Outside bottom.
        expect(computeNormalizedCoords(300, 600, rect)).toBeNull();
    });

    it("computeNormalizedCoords returns null for zero-sized rect", () => {
        // Defensive: a streaming wrapper that hasn't laid out yet has
        // width:0 height:0 — pick should refuse rather than divide by 0.
        expect(computeNormalizedCoords(50, 50, { left: 0, top: 0, width: 0, height: 0 })).toBeNull();
    });

    // ---- Show All toolbar button ----------------------------------------

    it("renders the Show All button alongside the pick toggle", () => {
        const ch = makeMockChannel();
        render(<ViewportPickHandler channel={ch} assetId="compass_step" />);
        expect(screen.getByTestId("viewport-pick-show-all")).toBeInTheDocument();
        // No hidden things initially — the count suffix should be absent.
        expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All");
    });

    it("Show All is disabled when channel is null", () => {
        render(<ViewportPickHandler channel={null} assetId="compass_step" />);
        expect(screen.getByTestId("viewport-pick-show-all")).toBeDisabled();
    });

    it("Show All click invokes channel.showAll", async () => {
        const showAll = vi.fn().mockResolvedValue({ shown_count: 42 });
        const ch = { ...makeMockChannel(), showAll } as any;
        render(<ViewportPickHandler channel={ch} assetId="compass_step" />);
        fireEvent.click(screen.getByTestId("viewport-pick-show-all"));
        await waitFor(() => expect(showAll).toHaveBeenCalledTimes(1));
    });

    // ---- Action menu: Hide / Isolate / Pick Material / Focus ------------

    async function renderAndPick(
        chOverrides: Partial<{
            pickSlot: (x: number, y: number) => Promise<typeof sampleSlot>;
            hidePrims: (paths: string[]) => Promise<{ hidden_count: number }>;
            isolatePrims: (paths: string[]) => Promise<{ isolated_count: number; hidden_count: number }>;
            showAll: () => Promise<{ shown_count: number }>;
            setMaterialOverride: (a: string, s: string, m: string) => Promise<{}>;
        }> = {},
    ) {
        const pickSlot = chOverrides.pickSlot ?? vi.fn().mockResolvedValue(sampleSlot);
        const hidePrims = chOverrides.hidePrims ?? vi.fn().mockResolvedValue({ hidden_count: 1 });
        const isolatePrims = chOverrides.isolatePrims
            ?? vi.fn().mockResolvedValue({ isolated_count: 4, hidden_count: 12 });
        const showAll = chOverrides.showAll ?? vi.fn().mockResolvedValue({ shown_count: 16 });
        const setMaterialOverride = chOverrides.setMaterialOverride
            ?? vi.fn().mockResolvedValue({});
        const ch = {
            ...makeMockChannel({ pickSlot, setMaterialOverride }),
            hidePrims,
            isolatePrims,
            showAll,
        } as any;
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        const result = render(
            <ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />,
        );
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        fireEvent.click(screen.getByTestId("viewport-pick-overlay"), {
            clientX: 500, clientY: 400, button: 0,
        });
        await waitFor(() =>
            expect(screen.getByTestId("viewport-pick-action-menu")).toBeInTheDocument(),
        );
        return { ch, hidePrims, isolatePrims, showAll, ...result };
    }

    it("clicking Hide on the action menu calls channel.hidePrims with the picked path", async () => {
        const { hidePrims } = await renderAndPick();
        fireEvent.click(screen.getByTestId("viewport-pick-action-hide"));
        await waitFor(() => expect(hidePrims).toHaveBeenCalledTimes(1));
        expect(hidePrims).toHaveBeenCalledWith(["/World/Compass/Body_09_Geom/Mesh"]);
        // Action menu dismissed after acting.
        expect(screen.queryByTestId("viewport-pick-action-menu")).not.toBeInTheDocument();
    });

    it("Hide adds the path to the hidden-set indicator", async () => {
        const { hidePrims } = await renderAndPick();
        fireEvent.click(screen.getByTestId("viewport-pick-action-hide"));
        await waitFor(() => expect(hidePrims).toHaveBeenCalled());
        // The Show All button text now includes the count suffix.
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All (1)");
        });
    });

    it("Show All clears the hidden-set", async () => {
        const { hidePrims, showAll } = await renderAndPick();
        // Hide first.
        fireEvent.click(screen.getByTestId("viewport-pick-action-hide"));
        await waitFor(() => expect(hidePrims).toHaveBeenCalled());
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All (1)");
        });
        // Click Show All.
        fireEvent.click(screen.getByTestId("viewport-pick-show-all"));
        await waitFor(() => expect(showAll).toHaveBeenCalled());
        // Indicator returns to bare "Show All".
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All");
        });
    });

    it("clicking Isolate on the action menu calls channel.isolatePrims with the picked path", async () => {
        const { isolatePrims } = await renderAndPick();
        fireEvent.click(screen.getByTestId("viewport-pick-action-isolate"));
        await waitFor(() => expect(isolatePrims).toHaveBeenCalledTimes(1));
        expect(isolatePrims).toHaveBeenCalledWith(["/World/Compass/Body_09_Geom/Mesh"]);
        // Menu dismissed.
        expect(screen.queryByTestId("viewport-pick-action-menu")).not.toBeInTheDocument();
    });

    it("clicking Pick Material on the action menu opens the picker modal", async () => {
        await renderAndPick();
        fireEvent.click(screen.getByTestId("viewport-pick-action-pick-material"));
        // Menu dismissed; picker modal opens.
        await waitFor(() => {
            expect(screen.queryByTestId("viewport-pick-action-menu")).not.toBeInTheDocument();
        });
        // The picker shows the slot's name (Body_09).
        await waitFor(() => {
            // Multiple Body_09 references are expected — at minimum one in
            // the picker's "applying to" header.
            expect(screen.queryAllByText(/body_09/i).length).toBeGreaterThan(0);
        });
    });

    it("Esc dismisses the action menu", async () => {
        await renderAndPick();
        await act(async () => {
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        });
        expect(screen.queryByTestId("viewport-pick-action-menu")).not.toBeInTheDocument();
    });

    it("clicking the backdrop dismisses the action menu", async () => {
        await renderAndPick();
        fireEvent.click(screen.getByTestId("viewport-pick-action-backdrop"));
        expect(screen.queryByTestId("viewport-pick-action-menu")).not.toBeInTheDocument();
    });

    it("Focus button is present but inert (parallel agent owns view.focus_at_point)", async () => {
        await renderAndPick();
        const focusBtn = screen.getByTestId("viewport-pick-action-focus");
        expect(focusBtn).toBeInTheDocument();
        // Click should NOT throw / lock up. Should dismiss the menu.
        fireEvent.click(focusBtn);
        await waitFor(() => {
            expect(screen.queryByTestId("viewport-pick-action-menu")).not.toBeInTheDocument();
        });
    });

    it("Hide failure surfaces a failed toast and does NOT track in hidden-set", async () => {
        const hidePrims = vi.fn().mockRejectedValue(new ChannelError("kit_internal", "boom"));
        const { rerender: _r } = await renderAndPick({ hidePrims });
        fireEvent.click(screen.getByTestId("viewport-pick-action-hide"));
        await waitFor(() => expect(hidePrims).toHaveBeenCalled());
        // Failed toast appears.
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-toast-failed")).toBeInTheDocument();
        });
        // No hidden-set increment — count suffix absent.
        expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All");
    });

    // ---- asset switch resets hidden-set ---------------------------------

    it("changing assetId resets the hidden-set", async () => {
        const ch = {
            ...makeMockChannel(),
            pickSlot: vi.fn().mockResolvedValue(sampleSlot),
            hidePrims: vi.fn().mockResolvedValue({ hidden_count: 1 }),
            isolatePrims: vi.fn().mockResolvedValue({ isolated_count: 1, hidden_count: 0 }),
            showAll: vi.fn().mockResolvedValue({ shown_count: 0 }),
        } as any;
        const ref = makeRefWithRect({ left: 0, top: 0, width: 1000, height: 800 });
        const { rerender } = render(
            <ViewportPickHandler channel={ch} assetId="compass_step" streamWrapperRef={ref} />,
        );
        // Pick + hide.
        fireEvent.click(screen.getByTestId("viewport-pick-toggle"));
        fireEvent.click(screen.getByTestId("viewport-pick-overlay"), {
            clientX: 500, clientY: 400, button: 0,
        });
        await waitFor(() =>
            expect(screen.getByTestId("viewport-pick-action-menu")).toBeInTheDocument(),
        );
        fireEvent.click(screen.getByTestId("viewport-pick-action-hide"));
        await waitFor(() => expect(ch.hidePrims).toHaveBeenCalled());
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All (1)");
        });
        // Switch asset.
        rerender(
            <ViewportPickHandler channel={ch} assetId="other_asset" streamWrapperRef={ref} />,
        );
        // Indicator clears.
        await waitFor(() => {
            expect(screen.getByTestId("viewport-pick-show-all").textContent).toBe("Show All");
        });
    });

    // ---- clampMenuPosition unit tests -----------------------------------

    it("clampMenuPosition keeps the menu inside the viewport", () => {
        // Click in the middle — menu fits below-and-right.
        const middle = clampMenuPosition(500, 400, 1000, 800);
        expect(middle.left).toBe(500 + 8); // anchorX + offset
        expect(middle.top).toBe(400 + 8);

        // Click near the right edge — menu flips to the LEFT.
        const right = clampMenuPosition(950, 400, 1000, 800);
        expect(right.left).toBeLessThan(950); // anchored on left side of click

        // Click near the bottom — menu flips UP.
        const bottom = clampMenuPosition(500, 750, 1000, 800);
        expect(bottom.top).toBeLessThan(750);

        // Click in the bottom-right — both flip.
        const corner = clampMenuPosition(990, 790, 1000, 800);
        expect(corner.left).toBeLessThan(990);
        expect(corner.top).toBeLessThan(790);
    });

    it("clampMenuPosition clamps to viewport bounds even with degenerate coords", () => {
        // Click at (0, 0) — would normally place menu at (8, 8); we stay
        // inside bounds.
        const tl = clampMenuPosition(0, 0, 1000, 800);
        expect(tl.left).toBeGreaterThanOrEqual(4);
        expect(tl.top).toBeGreaterThanOrEqual(4);
        // Click impossibly far right — clamp to viewport.
        const offRight = clampMenuPosition(5000, 5000, 1000, 800);
        expect(offRight.left + 168).toBeLessThanOrEqual(1000);
        expect(offRight.top + 184).toBeLessThanOrEqual(800);
    });
});
