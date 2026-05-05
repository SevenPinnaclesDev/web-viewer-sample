/*
 * input_channel_v1 type definitions — mirror clients/web/design/input-channel-v1.md.
 *
 * These types describe the wire shapes. SPA-side state shapes (e.g. UI
 * filter state) live in their respective components.
 *
 * Ryan Takeda — Phase 1 Day 1, 2026-05-01.
 */

// ---- envelope shapes (§4.1 / §4.2 / §4.3) --------------------------------

export interface ChannelRequest {
    id: string;                  // UUIDv4
    command: string;             // dotted namespace, e.g. "material.query_slots"
    payload: unknown;
}

export interface ChannelResponseOk<T = unknown> {
    id: string;
    ok: true;
    result: T;
}

export interface ChannelResponseErr {
    id: string;
    ok: false;
    error: { code: string; message: string };
}

export type ChannelResponse<T = unknown> = ChannelResponseOk<T> | ChannelResponseErr;

export interface ChannelEvent<T = Record<string, unknown>> {
    event: string;
    payload: T;
}

// ---- §5.1 material.query_slots --------------------------------------------

export interface MaterialSlot {
    /** Logical key — opaque to the SPA, stable across re-queries.
     * Server-side this is `<source_name>@<asset_id>`; SPA must not
     * depend on that format. Treat as opaque per contract. */
    slot_id: string;

    /** Un-mangled material name (e.g. "Diffuse"). Useless on its own at
     * scale per spike Compass observations; kept for diagnostics. */
    source_name: string;

    /** Elena's actual handle: derived from bound body names
     * (`tn__`-stripped). What the Twin Architect picks against. Falls
     * back to source_name if no bindings. */
    display_name: string;

    /** RGB triplet, 0–1 floats. May be null if no shader/no color. */
    placeholder_color: [number, number, number] | null;

    /** Summed across all scope-equivalent Material prims (per Surprise #4
     * consolidation rule). */
    bound_prim_count: number;

    /** Sample of body names — first ~16 unique. SPA shows first ~3 with
     * "and N more" pattern. */
    bound_body_names: string[];

    /** True if any override is currently applied for this slot on the
     * live stage. Day 1 always returns false (override write-path is
     * deferred to Day 2+). */
    is_overridden: boolean;

    /** Nucleus path of the active MDL when overridden, else null. */
    current_mdl_path: string | null;
}

export interface QuerySlotsResult {
    asset_id: string;
    slots: MaterialSlot[];
}

// ---- §5.5 material.set_overrides_bulk -------------------------------------

export interface BulkSkippedEntry {
    slot_id: string;
    reason: string; // contract: any error.code; e.g. "slot_not_found"
}

export interface SetOverridesBulkResult {
    applied: string[];
    skipped: BulkSkippedEntry[];
}

// ---- §6 reserved namespace `asset.*` --------------------------------------
// Phase 1 close-the-loop (2026-05-01) — `asset.open` is the first command
// in the asset.* namespace. The SPA fires it after the ingest pipeline's
// `completed` lifecycle frame; the kit extension resolves the slug to a
// Nucleus URL and asks omni.usd to open the stage. Once Kit's
// StageEventType.OPENED fires, extension.py emits the §4.3 `asset.opened`
// event and SwatchPanel auto-refreshes.

export interface OpenAssetRequest {
    asset_id: string;
    /** Optional — when omitted the kit targets `<slug>/current/scene.usd`. */
    version?: number;
    /** Optional — full nucleus URL override. When supplied, kit trusts it
     * verbatim and skips slug→URL resolution. The SPA can pull this
     * straight off the ingest pipeline's `completed` frame's `nucleus_url`
     * context value. */
    nucleus_url?: string;
}

export interface OpenAssetResult {
    asset_id: string;
    nucleus_url: string;
    open_request_acked: true;
    /** Echoed back when the request specified an explicit version. */
    version?: number;
}

// ---- §6 reserved namespace `selection.*` ----------------------------------
// Tap-to-pick (2026-05-04). The SPA captures a click on the streaming
// canvas, normalizes coords to [0..1], and fires `selection.pick_slot`.
// Kit raycasts, finds the bound material, and returns the same slot shape
// `material.query_slots` returns (for one slot) plus `prim_path_picked`.
// The SPA opens the picker pre-populated with that slot.

export interface PickSlotRequest {
    /** Normalized x coord in the streaming viewport, [0..1]. 0 = left edge, 1 = right. */
    x_norm: number;
    /** Normalized y coord in the streaming viewport, [0..1]. 0 = top edge, 1 = bottom. */
    y_norm: number;
    /** Optional viewport identifier. v1 only has one viewport — kit ignores. */
    viewport_id?: string;
}

/** Same shape as MaterialSlot, plus the prim path that was actually under
 *  the tap. Useful for diagnostic UX hints ("you tapped X, that's slot Y"). */
export interface PickSlotResult extends MaterialSlot {
    /** USD prim path of whatever the ray hit. Always set on success. */
    prim_path_picked: string;
}

// ---- §6 selection.* visibility primitives (2026-05-02 follow-up) ----------
// Hide / Isolate / Show-All for CAD-style inspection: pick a wall, hide
// it; isolate an assembly, study it alone; show-all to recover. The kit
// writes UsdGeomImageable.visibility on the prim ("invisible" / "inherited")
// — reversible without a stage round-trip.
//
// Server contract:
//   selection.hide_prims     — payload: { prim_paths: [...] }
//                              result:  { hidden_count: <n> }
//   selection.show_prims     — payload: { prim_paths: [...] }
//                              result:  { shown_count: <n> }
//   selection.isolate_prims  — payload: { prim_paths: [...] }  (≥1)
//                              result:  { isolated_count, hidden_count }
//   selection.show_all       — payload: {}
//                              result:  { shown_count: <n> }
//
// Errors: invalid_payload, no_active_stage, prim_not_found, kit_internal.

export interface HidePrimsRequest {
    prim_paths: string[];
}

export interface HidePrimsResult {
    hidden_count: number;
}

export interface ShowPrimsResult {
    shown_count: number;
}

export interface IsolatePrimsResult {
    isolated_count: number;
    hidden_count: number;
}

export interface ShowAllResult {
    shown_count: number;
}

// ---- §6 reserved namespace `library.*` ------------------------------------
// Picker sprint (2026-05-02) — `library.list_materials` is the first command
// in the library.* namespace. The SPA picker fires it on first open,
// caches the catalog in component-level state for the session.
//
// Catalog shape mirrors what tools/library-curator's `build` writes (see
// tools/library-curator/README.md "Catalog shape decisions") and matches
// clients/web/design/picker-ui-v1.md "Library structure on Nucleus".

export interface LibraryMaterialEntry {
    /** MDL filename (basename, including .mdl). */
    filename: string;
    /** Human-readable name shown in the picker grid + recently-used row. */
    display_name: string;
    /** Author-supplied tags — picker's search box matches against these. */
    tags: string[];
    /** Sibling thumbnail filename (relative to the category dir), or null
     * when the curator flagged it as missing. Picker renders a placeholder
     * swatch when null. */
    thumbnail: string | null;
    author: string;
    /** ISO date YYYY-MM-DD. */
    author_date: string;
}

export interface LibraryCategory {
    /** POSIX-style relative path from the library root, e.g. "Metals" or
     * "Plastics/ABS". The picker's folder tree mirrors this path. */
    path: string;
    /** Title-cased category name shown in the tree. */
    display_name: string;
    materials: LibraryMaterialEntry[];
}

export interface LibraryCatalog {
    /** Curator-stamped version. Default is today's date in YYYY-MM-DD;
     * Elena may override with semver or deployment-tagged values. */
    library_version: string;
    categories: LibraryCategory[];
}

// ---- spike fixture compatibility ------------------------------------------

/** The 2026-04-30 spike fixture shape. Kept for the regression check at
 * `?spike=slots` while the new SwatchPanel goes live against the channel. */
export interface SpikeSlotEntry {
    slot_id: string;            // USD path in spike — different from contract!
    source_name: string;
    display_name: string;
    placeholder_color: [number, number, number] | null;
    bound_prim_count: number;
    bound_prim_paths_sample: string[];
    is_in_prototypes: boolean;
}

export interface SpikeSlotFixture {
    asset: string;
    source_path: string;
    stage: { default_prim: string | null; meters_per_unit: number; up_axis: string };
    slots: SpikeSlotEntry[];
    summary: {
        slot_count: number;
        bound_slot_count: number;
        unbound_slot_count: number;
        duplicate_color_clusters: { color: [number, number, number]; slot_count: number }[];
    };
}

/**
 * Adapter — convert a spike fixture into the contract response shape so
 * the new SlotList can render the legacy fixtures in regression mode.
 *
 * The spike fixture didn't have logical-slot consolidation (Surprise #4
 * was the take-away); for the regression check we keep each slot as its
 * own entry rather than re-deduping client-side. The `slot_id` carries
 * the original USD path, which is fine for a read-only view.
 */
export function spikeFixtureToQueryResult(fixture: SpikeSlotFixture): QuerySlotsResult {
    const slots: MaterialSlot[] = fixture.slots.map((s) => {
        const bodyNames = s.bound_prim_paths_sample
            .map((p) => {
                const parts = p.split("/").filter(Boolean);
                let last = parts[parts.length - 1] === "Mesh" ? parts[parts.length - 2] : parts[parts.length - 1];
                if (last && last.startsWith("tn__")) {
                    last = last.slice(4).replace(/_[A-Za-z0-9]{2,12}$/, "");
                }
                return last ?? p;
            })
            .filter((b, i, a) => a.indexOf(b) === i);
        return {
            slot_id: s.slot_id,
            source_name: s.source_name,
            display_name: s.display_name,
            placeholder_color: s.placeholder_color,
            bound_prim_count: s.bound_prim_count,
            bound_body_names: bodyNames,
            is_overridden: false,
            current_mdl_path: null,
        };
    });
    return { asset_id: fixture.asset, slots };
}
