/*
 * SlotList — slot-list spike component, Ryan Takeda 2026-04-30
 *
 * Falsifiable question: are slot lists from Hoops consumable as a flat list,
 * or do they need flattening / dedup / parent-grouping before a swatch UI
 * can even render?
 *
 * This is the bare-minimum view: one row per slot, no picker, no remap,
 * no service wiring. Just the list.
 */
import { useMemo, useState } from "react";
import type { SlotEntry, SlotFixture } from "./types";
import "./SlotList.css";

interface Props {
    fixture: SlotFixture;
}

type GroupMode = "none" | "scope" | "color";

function rgbCss(c: [number, number, number] | null): string {
    if (!c) return "transparent";
    const [r, g, b] = c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return `rgb(${r}, ${g}, ${b})`;
}

function colorKey(c: [number, number, number] | null): string {
    if (!c) return "unbound";
    return c.map((v) => v.toFixed(3)).join(",");
}

/**
 * Derive a "scope label" from the slot path so we can group repeats
 * caused by Hoops's prototype-instancing pattern.
 *
 * Example slot_ids and the scope label we want:
 *   /compass_step/Looks/Diffuse_2                      → "(root)"
 *   /compass_step/Prototypes/Compass6000/Looks/Diffuse → "Prototypes/Compass6000"
 *   /compass_step/Prototypes/Compass6000_1/Looks/Foo   → "Prototypes/Compass6000_1"
 */
function scopeLabel(slotId: string): string {
    const parts = slotId.split("/").filter(Boolean);
    const looksIdx = parts.lastIndexOf("Looks");
    if (looksIdx < 1) return "(unknown)";
    // Drop the leading <asset> prim and the trailing /Looks/<material>.
    const middle = parts.slice(1, looksIdx);
    if (middle.length === 0) return "(root)";
    return middle.join("/");
}

/**
 * For a bound prim path like "/compass_step/Prototypes/Compass6000/tn__Body227_h7/Mesh"
 * pull out the body-name segment and clean up Hoops's tn__ mangling.
 */
function bodyNameFromPath(path: string): string {
    const parts = path.split("/").filter(Boolean);
    // Drop trailing "Mesh" if present.
    let last = parts[parts.length - 1] === "Mesh" ? parts[parts.length - 2] : parts[parts.length - 1];
    if (!last) return path;
    if (last.startsWith("tn__")) {
        last = last.slice(4);
        last = last.replace(/_[A-Za-z0-9]{2,12}$/, "");
    }
    return last;
}

export function SlotList({ fixture }: Props) {
    const [filter, setFilter] = useState("");
    const [group, setGroup] = useState<GroupMode>("none");
    const [showOnlyBound, setShowOnlyBound] = useState(false);

    const filtered = useMemo(() => {
        const f = filter.trim().toLowerCase();
        return fixture.slots.filter((s) => {
            if (showOnlyBound && s.bound_prim_count === 0) return false;
            if (!f) return true;
            return (
                s.source_name.toLowerCase().includes(f) ||
                s.display_name.toLowerCase().includes(f) ||
                s.slot_id.toLowerCase().includes(f) ||
                s.bound_prim_paths_sample.some((p) => p.toLowerCase().includes(f))
            );
        });
    }, [fixture.slots, filter, showOnlyBound]);

    const groups = useMemo(() => {
        if (group === "none") {
            return [{ key: "all", label: `All slots (${filtered.length})`, slots: filtered }];
        }
        const buckets = new Map<string, { label: string; slots: SlotEntry[] }>();
        for (const slot of filtered) {
            let key: string;
            let label: string;
            if (group === "scope") {
                key = scopeLabel(slot.slot_id);
                label = key;
            } else {
                key = colorKey(slot.placeholder_color);
                label = slot.placeholder_color
                    ? `RGB ${slot.placeholder_color.map((v) => v.toFixed(2)).join(", ")}`
                    : "(no color)";
            }
            if (!buckets.has(key)) buckets.set(key, { label, slots: [] });
            buckets.get(key)!.slots.push(slot);
        }
        return Array.from(buckets.entries()).map(([key, v]) => ({
            key,
            label: `${v.label} (${v.slots.length})`,
            slots: v.slots,
        }));
    }, [filtered, group]);

    const { summary } = fixture;

    return (
        <div className="slot-list">
            <div className="slot-list-header">
                <div className="slot-list-title">
                    <strong>{fixture.asset}</strong>
                    <span className="slot-list-stage-meta">
                        {fixture.stage.up_axis}-up · {fixture.stage.meters_per_unit} m/unit
                    </span>
                </div>
                <div className="slot-list-summary">
                    <span>
                        <strong>{summary.slot_count}</strong> slots
                    </span>
                    <span className="bound">{summary.bound_slot_count} bound</span>
                    <span className="unbound">{summary.unbound_slot_count} unbound</span>
                    {summary.duplicate_color_clusters.length > 0 && (
                        <span className="dup">
                            {summary.duplicate_color_clusters.length} repeat-color clusters
                        </span>
                    )}
                </div>
            </div>

            <div className="slot-list-controls">
                <input
                    type="text"
                    placeholder="Filter (name, path, body)…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <label>
                    Group by{" "}
                    <select value={group} onChange={(e) => setGroup(e.target.value as GroupMode)}>
                        <option value="none">none</option>
                        <option value="scope">scope (Hoops prototype dedup)</option>
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

            <div className="slot-list-rows">
                {groups.map((g) => (
                    <div key={g.key} className="slot-list-group">
                        {group !== "none" && (
                            <div className="slot-list-group-header">{g.label}</div>
                        )}
                        {g.slots.map((slot) => {
                            const sampleBodies = slot.bound_prim_paths_sample
                                .map(bodyNameFromPath)
                                .filter((b, i, a) => a.indexOf(b) === i);
                            return (
                                <div
                                    key={slot.slot_id}
                                    className={`slot-row ${slot.bound_prim_count === 0 ? "is-unbound" : ""}`}
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
                                            {slot.is_in_prototypes && (
                                                <span className="badge proto">proto</span>
                                            )}
                                            <span className="slot-bind-count">
                                                {slot.bound_prim_count} prim
                                                {slot.bound_prim_count === 1 ? "" : "s"}
                                            </span>
                                        </div>
                                        <div className="slot-path">{slot.slot_id}</div>
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
                {filtered.length === 0 && (
                    <div className="slot-list-empty">No slots match the current filter.</div>
                )}
            </div>
        </div>
    );
}
