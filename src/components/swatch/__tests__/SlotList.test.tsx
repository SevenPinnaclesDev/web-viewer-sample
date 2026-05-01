/*
 * SlotList component tests — render against contract §5.1 shape, verify
 * empty state, filter behavior, overridden indicator. No streaming, no
 * channel — pure component tests against the data it'll receive.
 *
 * Ryan Takeda — Phase 1 Day 1, 2026-05-01.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SlotList } from "../SlotList";
import type { MaterialSlot } from "../../../services/inputChannelTypes";

const compassSlots: MaterialSlot[] = [
    {
        slot_id: "Diffuse@compass_step",
        source_name: "Diffuse",
        display_name: "Body227",
        placeholder_color: [1.0, 0.63, 0.0],
        bound_prim_count: 7,
        bound_body_names: ["Body227", "Body228", "Body229", "Body230"],
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
    {
        slot_id: "Diffuse_2@compass_step",
        source_name: "Diffuse_2",
        display_name: "Diffuse 2",
        placeholder_color: [0.0, 0.82, 0.48],
        bound_prim_count: 0,
        bound_body_names: [],
        is_overridden: false,
        current_mdl_path: null,
    },
];

describe("SlotList", () => {
    it("renders one row per slot with display name + body sample", () => {
        render(<SlotList slots={compassSlots} assetId="compass_step" />);
        expect(screen.getAllByTestId("slot-row")).toHaveLength(3);
        expect(screen.getByText("Body227")).toBeInTheDocument();
        expect(screen.getByText("Body14141")).toBeInTheDocument();
        // bodies line shows "first 3" for the >3 case
        expect(screen.getByText(/Body227, Body228, Body229/)).toBeInTheDocument();
        expect(screen.getByText(/\+1$/)).toBeInTheDocument(); // "+1" overflow chip
    });

    it("acceptance criterion 6: empty slots renders the empty-state message", () => {
        render(<SlotList slots={[]} assetId="empty_asset" />);
        expect(screen.getByTestId("slot-list-empty")).toHaveTextContent(/No materials/i);
        expect(screen.queryAllByTestId("slot-row")).toHaveLength(0);
    });

    it("filter input narrows visible rows by source/body/slot_id", () => {
        render(<SlotList slots={compassSlots} assetId="x" />);
        const filter = screen.getByTestId("slot-list-filter") as HTMLInputElement;
        fireEvent.change(filter, { target: { value: "body14141" } });
        const rows = screen.getAllByTestId("slot-row");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent("Body14141");
    });

    it("bound-only checkbox hides unbound slots", () => {
        render(<SlotList slots={compassSlots} assetId="x" />);
        const cb = screen.getByLabelText(/Bound only/i) as HTMLInputElement;
        fireEvent.click(cb);
        const rows = screen.getAllByTestId("slot-row");
        expect(rows).toHaveLength(2); // Diffuse_2 has bound_prim_count: 0
    });

    it("overridden state renders the override badge and class", () => {
        const overridden: MaterialSlot[] = [{
            ...compassSlots[0],
            is_overridden: true,
            current_mdl_path: "omniverse://nucleus/Library/Materials/CarbonFiber.mdl",
        }];
        render(<SlotList slots={overridden} assetId="x" />);
        const row = screen.getByTestId("slot-row");
        expect(row.className).toContain("is-overridden");
        expect(row).toHaveTextContent(/overridden/i);
    });

    it("onSelect fires when a row is clicked", () => {
        const onSelect = vi.fn();
        render(<SlotList slots={compassSlots} assetId="x" onSelect={onSelect} />);
        fireEvent.click(screen.getAllByTestId("slot-row")[0]);
        expect(onSelect).toHaveBeenCalledWith(compassSlots[0]);
    });
});
