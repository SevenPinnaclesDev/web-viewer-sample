/*
 * Slot-list spike types — Ryan Takeda, 2026-04-30
 *
 * Shape mirrors what `query_material_slots` over `input_channel_v1` will
 * return in Phase 1. Fixture JSON in fixtures/elena-2026-04-30/ generated
 * by ryan/dump_material_slots.py against Elena's STEP→Hoops outputs on DASB256.
 */

export interface SlotEntry {
    slot_id: string;                       // USD prim path, e.g. /compass_step/Looks/Diffuse_2
    source_name: string;                   // Material prim name as it lives in USD
    display_name: string;                  // tn__-stripped, humanized
    placeholder_color: [number, number, number] | null;  // diffuseColor RGB, 0-1, or null
    bound_prim_count: number;
    bound_prim_paths_sample: string[];     // first 5 mesh paths bound to this slot
    is_in_prototypes: boolean;
}

export interface ColorCluster {
    color: [number, number, number];
    slot_count: number;
}

export interface SlotFixture {
    asset: string;
    source_path: string;
    stage: {
        default_prim: string | null;
        meters_per_unit: number;
        up_axis: string;
    };
    slots: SlotEntry[];
    summary: {
        slot_count: number;
        bound_slot_count: number;
        unbound_slot_count: number;
        duplicate_color_clusters: ColorCluster[];
    };
    spike_meta?: {
        generated_by: string;
        purpose: string;
    };
}
