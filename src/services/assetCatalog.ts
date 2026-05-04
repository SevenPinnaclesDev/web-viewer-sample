/*
 * assetCatalog.ts — SPA-side fetch wrapper for the DATE ingest service's
 * `GET /assets` endpoint.
 *
 * Mirrors the structure of `ingestLifecycle.ts`: thin testable layer with
 * an injectable transport (fetch), explicit types matching Diana's
 * server-side contract, no UI concerns.
 *
 * Endpoint contract — coordinated with Diana 2026-05-02:
 *
 *     GET <ingestServiceUrl>/assets[?limit=100&prefix=foo]
 *     200 → AssetSummary[]   (sorted desc by ingest_at)
 *     5xx → JSON { detail: string }
 *
 * Each AssetSummary describes one asset *currently published on Nucleus*,
 * meaning its ingest worker reached the `completed` state. The ingest
 * service is the source of truth here; nothing reads Nucleus directly
 * from the SPA.
 *
 * The Asset Browser panel calls `listAssets()` on mount + on the refresh
 * button. The returned `omniverse_url` is what we hand to
 * `inputChannel.openAsset(slug, undefined, omniverse_url)` — same path
 * the daemon uses, so we re-use the kit-side `resolve_asset_url`
 * verbatim-honors-URL behavior.
 *
 * Ryan Takeda — Asset Browser sprint, 2026-05-02.
 */

// ---- Wire shape — must match server/ingest/service models ---------------

/**
 * One row in the catalog response. Matches Diana's
 * `server/ingest/service/models.AssetSummary`.
 *
 * Field notes:
 *  - `slug` is the slugified asset name (kebab-or-underscore — pipeline
 *    decides; slug is opaque to the SPA).
 *  - `current_version` is the latest version number (1-indexed).
 *  - `omniverse_url` is fully resolved including scheme + host + path; the
 *    SPA passes it verbatim into `openAsset` so kit-side re-derivation
 *    is bypassed (same trick we use in DropZone for the daemon path).
 *  - `source_format` is the originally-uploaded format ("usdz" | "step" |
 *    "ifc" | …) — we surface it on the card for at-a-glance context.
 *  - `ingest_at` is ISO8601 UTC with offset; the SPA renders it with a
 *    locale-aware short form (date-only at v1).
 *  - `thumbnail_url` is null at v1; the field is reserved for the
 *    library-curator-style thumbnail proxy work.
 */
export interface AssetSummary {
    asset_id: string;
    slug: string;
    current_version: number;
    omniverse_url: string;
    source_format: string;
    ingest_at: string;
    thumbnail_url: string | null;
}

export type AssetListResponse = AssetSummary[];

// ---- Options + error types ----------------------------------------------

/** Optional injection seam for tests. The default is `window.fetch`. */
export type FetchFn = typeof fetch;

export interface ListAssetsOptions {
    /** Cap the response. Server default is 100. */
    limit?: number;
    /** Substring-prefix filter on slug. Server-side; the panel also does
     * client-side substring search for snappier UX once the list is loaded. */
    prefix?: string;
    /** Override the fetch impl for tests. */
    fetchFn?: FetchFn;
    /** AbortSignal for cancelling the request (e.g. on component unmount). */
    signal?: AbortSignal;
}

/** Error thrown by listAssets on non-2xx responses or transport failures.
 * Carries the HTTP status when available so the caller can distinguish
 * transient (5xx → retry) from permanent (4xx → tell the user). */
export class AssetCatalogError extends Error {
    /** HTTP status code if the request reached the server; -1 for
     * transport-level failure (connection refused, DNS error, etc.). */
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = "AssetCatalogError";
        this.status = status;
    }
}

// ---- Implementation -----------------------------------------------------

/**
 * Build the GET /assets URL with optional query params. Exported for
 * tests — the panel never builds URLs directly, it calls listAssets().
 */
export function buildAssetListUrl(
    ingestServiceUrl: string,
    opts: { limit?: number; prefix?: string } = {},
): string {
    const base = ingestServiceUrl.replace(/\/$/, "");
    const params = new URLSearchParams();
    if (opts.limit !== undefined && opts.limit > 0) {
        params.set("limit", String(opts.limit));
    }
    if (opts.prefix !== undefined && opts.prefix !== "") {
        params.set("prefix", opts.prefix);
    }
    const qs = params.toString();
    return qs ? `${base}/assets?${qs}` : `${base}/assets`;
}

/**
 * Fetch the asset catalog from the ingest service.
 *
 * Returns the parsed array on success. Throws AssetCatalogError on any
 * non-2xx / transport / parse failure — the caller (AssetBrowser) shows
 * an error state and offers a retry.
 *
 * The function defensively coerces the response: it expects an array of
 * AssetSummary-shaped objects, but a non-array body (e.g. `{detail: "x"}`
 * from a misconfigured server) throws rather than masquerading as an
 * empty list. An empty array is a valid response (no assets ingested
 * yet) — that's the empty-state UX trigger.
 */
export async function listAssets(
    ingestServiceUrl: string,
    opts: ListAssetsOptions = {},
): Promise<AssetSummary[]> {
    const fetchImpl = opts.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
    if (!fetchImpl) {
        throw new AssetCatalogError(-1, "fetch unavailable in this environment");
    }

    const url = buildAssetListUrl(ingestServiceUrl, opts);

    let resp: Response;
    try {
        resp = await fetchImpl(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: opts.signal,
        });
    } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
            // Re-throw aborts unchanged so callers can distinguish.
            throw err;
        }
        throw new AssetCatalogError(
            -1,
            `GET /assets failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!resp.ok) {
        let detail = `${resp.status} ${resp.statusText}`;
        try {
            const body = await resp.text();
            if (body) detail += ` — ${body.slice(0, 200)}`;
        } catch {
            /* fall through with status only */
        }
        throw new AssetCatalogError(resp.status, `GET /assets: ${detail}`);
    }

    let parsed: unknown;
    try {
        parsed = await resp.json();
    } catch (err) {
        throw new AssetCatalogError(
            resp.status,
            `GET /assets returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    if (!Array.isArray(parsed)) {
        throw new AssetCatalogError(
            resp.status,
            `GET /assets expected array, got ${typeof parsed}`,
        );
    }

    return parsed.map(coerceAssetSummary).filter((a): a is AssetSummary => a !== null);
}

/**
 * Tolerantly map an unknown object to AssetSummary, dropping rows that
 * don't have at least `slug` + `omniverse_url` (the two fields the
 * Browser actually needs to function).
 *
 * Diana's server enforces the full shape at the seam, but we coerce
 * defensively so a single bad row doesn't break the whole panel.
 */
function coerceAssetSummary(raw: unknown): AssetSummary | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const slug = typeof r.slug === "string" ? r.slug : null;
    const omniverse_url = typeof r.omniverse_url === "string" ? r.omniverse_url : null;
    if (!slug || !omniverse_url) return null;
    return {
        asset_id: typeof r.asset_id === "string" ? r.asset_id : slug,
        slug,
        current_version: typeof r.current_version === "number"
            ? r.current_version
            : (typeof r.current_version === "string" ? parseInt(r.current_version, 10) || 1 : 1),
        omniverse_url,
        source_format: typeof r.source_format === "string" ? r.source_format : "",
        ingest_at: typeof r.ingest_at === "string" ? r.ingest_at : "",
        thumbnail_url: typeof r.thumbnail_url === "string" ? r.thumbnail_url : null,
    };
}
