/*
 * Drag-drop types — accepted file extensions, ingest-response shape, etc.
 *
 * Ryan Takeda — Phase 1 close-the-loop, 2026-05-01.
 */

/**
 * Extensions Diana's auto-router will route to a known pipeline. Anything
 * outside this set we reject client-side with a friendly error before
 * bothering the server.
 *
 * Sourced from `architecture/ingest-service.md` §2 (CAD/ME via Hoops:
 * .stp/.step/.iges/.igs/.stl/.obj/.dxf/.dwg/.3mf, USD passthrough:
 * .usd/.usda/.usdc/.usdz, AEC via IFC: .ifc/.ifczip).
 */
export const ACCEPTED_EXTENSIONS: ReadonlySet<string> = new Set([
    // CAD/ME
    "stp", "step",
    "iges", "igs",
    "stl",
    "obj",
    "dxf", "dwg",
    "3mf",
    "x_t", "x_b",  // Parasolid (Shapr3D twin-format companion)
    // AEC / IFC
    "ifc", "ifczip",
    // USD passthrough
    "usd", "usda", "usdc", "usdz",
]);

export function getFileExtension(filename: string): string {
    const dot = filename.lastIndexOf(".");
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function isAcceptedFile(filename: string): boolean {
    return ACCEPTED_EXTENSIONS.has(getFileExtension(filename));
}

/** POST /ingest response — single-file path. Mirrors
 * `server/ingest/service/models.IngestResponse`'s convenience fields.
 * Multi-file (Shapr3D twin-format) responses use the `files` array; the
 * SPA's drag-drop assumes single-file for now.
 */
export interface IngestPostResponse {
    asset_id?: string;
    ws_url?: string;
    expected_pipeline?: string;
    source_filename?: string;
    bytes_written?: number;
    warning?: string;
    files?: Array<{
        file_index: number;
        original_filename: string;
        bytes_written: number;
        source_class: string;
        pipeline: string;
        job_id?: string;
        asset_id?: string;
        ws_url?: string;
        routed_reason?: string;
        magic_bytes_hex_prefix?: string;
        companion_of?: string;
        warning?: string;
    }>;
}
