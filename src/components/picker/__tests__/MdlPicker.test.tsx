/*
 * MdlPicker component tests — Phase 1 picker sprint, 2026-05-02.
 *
 * Coverage matches the success criteria in CLAUDE.md prompt:
 *   - picker opens with single-slot header
 *   - picker opens with bulk header
 *   - search filters grid live
 *   - click on a card invokes onPick with the right composed mdl_path
 *   - Esc dismisses
 *   - X button dismisses
 *   - click-outside dismisses
 *   - recently-used row renders when populated
 *   - loading state when catalog is null
 *   - error state with retry button
 *   - empty-library state when catalog has zero categories
 *
 * Catalog is mocked at the component boundary — picker doesn't talk to a
 * channel directly.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MdlPicker, type MdlPickerPick } from "../MdlPicker";
import type {
    LibraryCatalog,
    MaterialSlot,
} from "../../../services/inputChannelTypes";

const sampleSlot: MaterialSlot = {
    slot_id: "Diffuse@compass_step",
    source_name: "Diffuse",
    display_name: "Body227",
    placeholder_color: [1.0, 0.63, 0.0],
    bound_prim_count: 7,
    bound_body_names: ["Body227"],
    is_overridden: false,
    current_mdl_path: null,
};

const otherSlot: MaterialSlot = {
    slot_id: "Diffuse_1@compass_step",
    source_name: "Diffuse_1",
    display_name: "Body14141",
    placeholder_color: [0.165, 0.298, 0.192],
    bound_prim_count: 1,
    bound_body_names: ["Body14141"],
    is_overridden: false,
    current_mdl_path: null,
};

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
                    tags: ["metal", "aluminum", "brushed"],
                    thumbnail: "Aluminum_Brushed.png",
                    author: "Elena",
                    author_date: "2026-05-15",
                },
                {
                    filename: "Steel_Polished.mdl",
                    display_name: "Polished Steel",
                    tags: ["metal", "steel", "polished"],
                    thumbnail: "Steel_Polished.png",
                    author: "Elena",
                    author_date: "2026-05-15",
                },
            ],
        },
        {
            path: "Plastics",
            display_name: "Plastics",
            materials: [
                {
                    filename: "Plastic_ABS_White.mdl",
                    display_name: "ABS White",
                    tags: ["plastic", "abs", "white"],
                    thumbnail: "Plastic_ABS_White.png",
                    author: "Elena",
                    author_date: "2026-05-15",
                },
            ],
        },
    ],
};

const TEST_LIBRARY_ROOT = "omniverse://nucleus.test/DATE/Library/Materials";

describe("MdlPicker", () => {
    it("renders nothing when open=false", () => {
        const { container } = render(
            <MdlPicker
                open={false}
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        expect(container.firstChild).toBeNull();
    });

    it("opens with single-slot header", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        expect(screen.getByTestId("mdl-picker-overlay")).toBeInTheDocument();
        const header = screen.getByTestId("mdl-picker-header-single");
        expect(header).toHaveTextContent(/Pick a material for/i);
        expect(header).toHaveTextContent(/Body227/);
        expect(header).toHaveTextContent(/7 prims/);
    });

    it("opens with bulk header for multiple target slots", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot, otherSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        const header = screen.getByTestId("mdl-picker-header-bulk");
        expect(header).toHaveTextContent(/Pick material for/i);
        expect(header).toHaveTextContent(/2/);
        expect(header).toHaveTextContent(/selected slots/i);
    });

    it("renders all materials across categories on open", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        const cards = screen.getAllByTestId("mdl-picker-card");
        expect(cards).toHaveLength(3);
        expect(screen.getByText("Brushed Aluminum")).toBeInTheDocument();
        expect(screen.getByText("Polished Steel")).toBeInTheDocument();
        expect(screen.getByText("ABS White")).toBeInTheDocument();
    });

    it("search filters the grid live by display_name", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        const search = screen.getByTestId("mdl-picker-search") as HTMLInputElement;
        fireEvent.change(search, { target: { value: "polished" } });
        const cards = screen.getAllByTestId("mdl-picker-card");
        expect(cards).toHaveLength(1);
        expect(cards[0]).toHaveAttribute("data-mdl-filename", "Steel_Polished.mdl");
    });

    it("search filters by tag (matches against catalog tags)", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        const search = screen.getByTestId("mdl-picker-search") as HTMLInputElement;
        fireEvent.change(search, { target: { value: "abs" } });
        const cards = screen.getAllByTestId("mdl-picker-card");
        expect(cards).toHaveLength(1);
        expect(cards[0]).toHaveAttribute("data-mdl-filename", "Plastic_ABS_White.mdl");
    });

    it("search with no matches shows empty-search state", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        const search = screen.getByTestId("mdl-picker-search") as HTMLInputElement;
        fireEvent.change(search, { target: { value: "nonexistentmaterialxyz" } });
        expect(screen.getByTestId("mdl-picker-empty-search")).toBeInTheDocument();
        expect(screen.queryAllByTestId("mdl-picker-card")).toHaveLength(0);
    });

    it("clicking a tree item filters to that category", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        // Initial state — all 3 visible
        expect(screen.getAllByTestId("mdl-picker-card")).toHaveLength(3);
        // Click Plastics in tree — only 1 should remain
        fireEvent.click(screen.getByTestId("mdl-picker-tree-Plastics"));
        const cards = screen.getAllByTestId("mdl-picker-card");
        expect(cards).toHaveLength(1);
        expect(cards[0]).toHaveAttribute("data-mdl-filename", "Plastic_ABS_White.mdl");
    });

    it("click on an MDL card invokes onPick with composed mdl_path", () => {
        const onPick = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={onPick}
                onDismiss={vi.fn()}
                libraryRootUrl={TEST_LIBRARY_ROOT}
            />,
        );
        const cards = screen.getAllByTestId("mdl-picker-card");
        // Click the first one — should be Brushed Aluminum (Metals category, first material).
        fireEvent.click(cards[0]);
        expect(onPick).toHaveBeenCalledTimes(1);
        const pick = onPick.mock.calls[0][0] as MdlPickerPick;
        expect(pick.mdlPath).toBe(`${TEST_LIBRARY_ROOT}/Metals/Aluminum_Brushed.mdl`);
        expect(pick.displayName).toBe("Brushed Aluminum");
        expect(pick.entry.filename).toBe("Aluminum_Brushed.mdl");
        expect(pick.category.path).toBe("Metals");
    });

    it("Esc fires onDismiss", () => {
        const onDismiss = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={onDismiss}
            />,
        );
        fireEvent.keyDown(window, { key: "Escape" });
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("X close button fires onDismiss", () => {
        const onDismiss = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={onDismiss}
            />,
        );
        fireEvent.click(screen.getByTestId("mdl-picker-close"));
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("click on overlay (outside modal) fires onDismiss", () => {
        const onDismiss = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={onDismiss}
            />,
        );
        const overlay = screen.getByTestId("mdl-picker-overlay");
        // fireEvent.click on overlay triggers our handler with target=overlay.
        fireEvent.click(overlay);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("click inside the modal does NOT dismiss", () => {
        const onDismiss = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={onDismiss}
            />,
        );
        // Click the modal itself (not the overlay) — should not dismiss.
        fireEvent.click(screen.getByTestId("mdl-picker-modal"));
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it("renders recently-used row when populated", () => {
        const recentlyUsed: MdlPickerPick[] = [{
            mdlPath: `${TEST_LIBRARY_ROOT}/Metals/Aluminum_Brushed.mdl`,
            displayName: "Brushed Aluminum",
            entry: sampleCatalog.categories[0].materials[0],
            category: sampleCatalog.categories[0],
        }];
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
                recentlyUsed={recentlyUsed}
            />,
        );
        expect(screen.getByTestId("mdl-picker-recent-section")).toBeInTheDocument();
        expect(screen.getAllByTestId("mdl-picker-recent-card")).toHaveLength(1);
    });

    it("recently-used row hides when search is active", () => {
        const recentlyUsed: MdlPickerPick[] = [{
            mdlPath: `${TEST_LIBRARY_ROOT}/Metals/Aluminum_Brushed.mdl`,
            displayName: "Brushed Aluminum",
            entry: sampleCatalog.categories[0].materials[0],
            category: sampleCatalog.categories[0],
        }];
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
                recentlyUsed={recentlyUsed}
            />,
        );
        // Pre-condition: recently-used visible
        expect(screen.queryByTestId("mdl-picker-recent-section")).toBeInTheDocument();
        const search = screen.getByTestId("mdl-picker-search") as HTMLInputElement;
        fireEvent.change(search, { target: { value: "polished" } });
        // Now hidden
        expect(screen.queryByTestId("mdl-picker-recent-section")).not.toBeInTheDocument();
    });

    it("clicking a recently-used card invokes onPick with the cached pick", () => {
        const recentlyUsed: MdlPickerPick[] = [{
            mdlPath: `${TEST_LIBRARY_ROOT}/Metals/Aluminum_Brushed.mdl`,
            displayName: "Brushed Aluminum",
            entry: sampleCatalog.categories[0].materials[0],
            category: sampleCatalog.categories[0],
        }];
        const onPick = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={onPick}
                onDismiss={vi.fn()}
                recentlyUsed={recentlyUsed}
            />,
        );
        fireEvent.click(screen.getAllByTestId("mdl-picker-recent-card")[0]);
        expect(onPick).toHaveBeenCalledWith(recentlyUsed[0]);
    });

    it("renders loading state when catalog is null and no error", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={null}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        expect(screen.getByTestId("mdl-picker-loading")).toBeInTheDocument();
    });

    it("renders error state with retry button when loadError set", () => {
        const onRetryFetch = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={null}
                loadError="library_not_found: catalog missing on Nucleus"
                onRetryFetch={onRetryFetch}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        expect(screen.getByTestId("mdl-picker-error")).toBeInTheDocument();
        expect(screen.getByText(/library_not_found/)).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("mdl-picker-retry"));
        expect(onRetryFetch).toHaveBeenCalledTimes(1);
    });

    it("renders empty-library state when catalog has zero categories", () => {
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={{ library_version: "x", categories: [] }}
                onPick={vi.fn()}
                onDismiss={vi.fn()}
            />,
        );
        expect(screen.getByTestId("mdl-picker-empty")).toBeInTheDocument();
    });

    it("composes mdl_path correctly when libraryRootUrl has trailing slash", () => {
        const onPick = vi.fn();
        render(
            <MdlPicker
                open
                targetSlots={[sampleSlot]}
                catalog={sampleCatalog}
                onPick={onPick}
                onDismiss={vi.fn()}
                libraryRootUrl={`${TEST_LIBRARY_ROOT}/`}
            />,
        );
        fireEvent.click(screen.getAllByTestId("mdl-picker-card")[0]);
        // No double slash even with trailing-/ root.
        const pick = onPick.mock.calls[0][0] as MdlPickerPick;
        expect(pick.mdlPath).toBe(`${TEST_LIBRARY_ROOT}/Metals/Aluminum_Brushed.mdl`);
    });
});
