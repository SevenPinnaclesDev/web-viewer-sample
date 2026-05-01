/*
 * SlotList — paint-swatch primitive's slot enumerator.
 *
 * Phase 1 Day 1 evolution from the 2026-04-30 spike: same render shape,
 * now reads contract §5.1 (`MaterialSlot[]`) directly instead of the
 * spike's enriched `SlotFixture`. Server-side scope-equivalence dedup
 * (per spike Surprise #4) means the SPA gets a clean logical-slot list
 * already collapsed; "group by scope" no longer makes sense (every entry
 * is *already* one logical scope), but "group by color" stays — Elena's
 * ask #1 ("all the orange parts").
 *
 * What's gone vs. spike:
 *   - is_in_prototypes badge (server-side consolidation eats this distinction)
 *   - "group by scope" (consolidation makes it a no-op)
 *   - duplicate_color_clusters callout in header (was a spike-only
 *     diagnostic to surface the prototype-instancing pattern; with
 *     consolidation done server-side, the cluster count drops to <=N
 *     logical and is no longer a usability win)
 *
 * What's new:
 *   - is_overridden indicator on the row (Day 2+ shows current MDL)
 *   - render from a `slots: MaterialSlot[]` array directly; the parent
 *     owns loading state
 *
 * Ryan Takeda — Phase 1 Day 1, 2026-05-01.
 */
import { useMemo, useState } from "react";
import type { MaterialSlot } from "../../services/inputChannelTypes";
import "./SlotList.css";

export type GroupMode = "none" | "color";

export interface SlotListProps {
    slots: MaterialSlot[];
    /** Asset slug, shown in the header. Optional — when called from a
     * regression-check path with synthesized fixtures, may be absent. */
    assetId?: string;
    /** Optional click handler — Day 2+ wires this to open the MDL picker.
     * Day 1: not used. */
    onSelect?: (slot: MaterialSlot) => void;
}

function rgbCss(c: [number, number, number] | null): string {
    if (!c) return "transparent";
    const [r, g, b] = c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return `rgb(${r}, ${g}, ${b})`;
}

function colorKey(c: [number, number, number] | null): string {
    if (!c) return "unbound";
    return c.map((v) => v.toFixed(3)).join(",");
}

export function SlotList({ slots, assetId, onSelect }: SlotListProps) {
    const [filter, setFilter] = useState("");
    const [group, setGroup] = useState<GroupMode>("none");
    const [showOnlyBound, setShowOnlyBound] = useState(false);

    const filtered = useMemo(() => {
        const f = filter.trim().toLowerCase();
        return slots.filter((s) => {
            if (showOnlyBound && s.bound_prim_count === 0) return false;
            if (!f) return true;
            return (
                s.source_name.toLowerCase().includes(f) ||
                s.display_name.toLowerCase().includes(f) ||
                s.slot_id.toLowerCase().includes(f) ||
                s.bound_body_names.some((b) => b.toLowerCase().includes(f))
            );
        });
    }, [slots, filter, showOnlyBound]);

    const groups = useMemo(() => {
        if (group === "none") {
            return [{ key: "all", label: `All slots (${filtered.length})`, slots: filtered }];
        }
        const buckets = new Map<string, { label: string; slots: MaterialSlot[] }>();
        for (const slot of filtered) {
            const key = colorKey(slot.placeholder_color);
            const label = slot.placeholder_color
                ? `RGB ${slot.placeholder_color.map((v) => v.toFixed(2)).join(", ")}`
                : "(no color)";
            if (!buckets.has(key)) buckets.set(key, { label, slots: [] });
            buckets.get(key)!.slots.push(slot);
        }
        return Array.from(buckets.entries()).map(([key, v]) => ({
            key,
            label: `${v.label} (${v.slots.length})`,
            slots: v.slots,
        }));
    }, [filtered, group]);

    const summaryBound = useMemo(
        () => slots.filter((s) => s.bound_prim_count > 0).length,
        [slots],
    );
    const summaryOverridden = useMemo(
        () => slots.filter((s) => s.is_overridden).length,
        [slots],
    );

    return (
        <div className="slot-list" data-testid="slot-list">
            <div className="slot-list-header">
                <div className="slot-list-title">
                    <strong>{assetId ?? "(no asset)"}</strong>
                </div>
                <div className="slot-list-summary">
                    <span>
                        <strong>{slots.length}</strong> logical slots
                    </span>
                    <span className="bound">{summaryBound} bound</span>
                    <span className="unbound">{slots.length - summaryBound} unbound</span>
                    {summaryOverridden > 0 && (
                        <span className="overridden">
                            {summaryOverridden} overridden
                        </span>
                    )}
                </div>
            </div>

            <div className="slot-list-controls">
                <input
                    data-testid="slot-list-filter"
                    type="text"
                    placeholder="Filter (name, body, slot id)…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <label>
                    Group by{" "}
                    <select value={group} onChange={(e) => setGroup(e.target.value as GroupMode)}>
                        <option value="none">none</option>
                        <option value="color">color (placeholder shade)</option>
                    </select>
                </label>
                <label className="checkbox">
                    <input
                        type="checkbox"
                        checked={showOnlyBound}
                        onChange={(e) => setShowOnlyBound(e.target.checked)}
                    />
                    Bound only
                </label>
            </div>

            <div className="slot-list-rows" data-testid="slot-list-rows">
                {slots.length === 0 && (
                    <div className="slot-list-empty" data-testid="slot-list-empty">
                        No materials in this asset.
                    </div>
                )}
                {slots.length > 0 && filtered.length === 0 && (
                    <div className="slot-list-empty">No slots match the current filter.</div>
                )}
                {groups.map((g) => (
                    <div key={g.key} className="slot-list-group">
                        {group !== "none" && (
                            <div className="slot-list-group-header">{g.label}</div>
                        )}
                        {g.slots.map((slot) => {
                            const sampleBodies = slot.bound_body_names;
                            return (
                                <div
                                    key={slot.slot_id}
                                    data-testid="slot-row"
                                    data-slot-id={slot.slot_id}
                                    className={`slot-row ${slot.bound_prim_count === 0 ? "is-unbound" : ""} ${slot.is_overridden ? "is-overridden" : ""}`}
                                    onClick={onSelect ? () => onSelect(slot) : undefined}
                                    style={onSelect ? { cursor: "pointer" } : undefined}
                                >
                                    <div
                                        className="swatch"
                                        style={{ background: rgbCss(slot.placeholder_color) }}
                                        title={
                                            slot.placeholder_color
                                                ? `RGB ${slot.placeholder_color.join(", ")}`
                                                : "no color"
                                        }
                                    />
                                    <div className="slot-meta">
                                        <div className="slot-name-row">
                                            <span className="slot-name">{slot.display_name}</span>
                                            {slot.is_overridden && (
                                                <span className="badge overridden">overridden</span>
                                            )}
                                            <span className="slot-bind-count">
                                                {slot.bound_prim_count} prim
                                                {slot.bound_prim_count === 1 ? "" : "s"}
                                            </span>
                                        </div>
                                        <div className="slot-path">
                                            {slot.source_name} · {slot.slot_id}
                                        </div>
                                        {sampleBodies.length > 0 && (
                                            <div className="slot-bodies">
                                                bodies: {sampleBodies.slice(0, 3).join(", ")}
                                                {sampleBodies.length > 3 && ` +${sampleBodies.length - 3}`}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ))}
            </div>
        </div>
    );
}
