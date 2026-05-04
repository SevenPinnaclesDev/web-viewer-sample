/*
 * AssetBrowser — collapsible left-sidebar panel that browses assets
 * already published on Nucleus and lets the user load any of them with
 * a single click.
 *
 * Why this exists: today the only path to view an asset is to drop a
 * file (DropZone POSTs to /ingest, lifecycle progresses, daemon hands
 * back ?asset= to fire openAsset). Every previously-ingested asset
 * sits permanently on Nucleus, but the SPA had no way to re-pick one.
 * AssetBrowser closes that loop — it's a Finder over the user's
 * Nucleus library.
 *
 * Layout: sidebar fixed at left edge, ~280px wide, semi-transparent so
 * the streamed canvas remains visible behind. Default state is
 * collapsed (a small toggle pill at top-left); the user opens the
 * panel when they want to switch assets. This keeps the streaming view
 * full-width by default — the panel is a tool, not the home screen.
 *
 * Loading semantics: catalog fetched on mount + on the explicit refresh
 * button. We do *not* auto-refresh on a timer — the catalog grows on
 * ingest completion and the user already sees that path through the
 * DropZone toast; a refresh button gives them a clear "I expect a new
 * asset to be visible now" affordance without us guessing about cache
 * invalidation.
 *
 * Click semantics: single click on a card fires
 * `inputChannel.openAsset(slug, undefined, omniverse_url)` — same path
 * the daemon's URL handler uses. We forward the omniverse_url verbatim
 * so the kit-side resolver bypasses slug→path derivation, mirroring the
 * authoritative pattern in DropZone.tsx.
 *
 * Search: client-side substring match on slug. Server-side `prefix`
 * support exists but we don't surface it at v1 — the panel paginates at
 * the server's default limit and lets the user scroll/filter locally.
 *
 * Spec: parent task brief (Asset Browser v1, 2026-05-02). Same
 * testability seam as DropZone (injectable fetch + InputChannel).
 *
 * Ryan Takeda — Asset Browser sprint, 2026-05-02.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    listAssets,
    AssetCatalogError,
    type AssetSummary,
    type FetchFn,
} from "../../services/assetCatalog";
import type { InputChannel } from "../../services/inputChannel";
import "./AssetBrowser.css";


export interface AssetBrowserProps {
    /** Live channel used to fire asset.open on card click. May be null
     * if the kit stream isn't connected yet — cards then surface a
     * "stream not ready" toast instead of blowing up. */
    channel: InputChannel | null;

    /** Base URL of the ingest service. Production: the Caddy-fronted
     * https endpoint on DASB256 (also used by DropZone). */
    ingestServiceUrl: string;

    /** Override fetch for tests. Default: window.fetch. */
    fetchFn?: FetchFn;

    /** Default to false (panel collapsed by default). The user opens
     * it deliberately. Tests can pass true to render expanded. */
    initiallyExpanded?: boolean;

    /** Server-side limit on /assets. Default: 100 (Diana's server default). */
    limit?: number;
}

type LoadState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "loaded"; assets: AssetSummary[] }
    | { kind: "error"; message: string };

type ToastState =
    | { kind: "hidden" }
    | { kind: "loading"; slug: string }
    | { kind: "loaded"; slug: string }
    | { kind: "failed"; slug: string; reason: string };


export function AssetBrowser({
    channel,
    ingestServiceUrl,
    fetchFn,
    initiallyExpanded = false,
    limit = 100,
}: AssetBrowserProps) {
    const [expanded, setExpanded] = useState(initiallyExpanded);
    const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
    const [search, setSearch] = useState("");
    const [toast, setToast] = useState<ToastState>({ kind: "hidden" });
    const [activeSlug, setActiveSlug] = useState<string | null>(null);

    // Keep an AbortController for in-flight fetches so unmount + rapid
    // refresh clicks don't race. The fetch wrapper re-throws AbortError
    // unchanged so we can branch on it.
    const controllerRef = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        // Cancel any in-flight fetch.
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;

        setLoadState({ kind: "loading" });
        try {
            const assets = await listAssets(ingestServiceUrl, {
                fetchFn,
                limit,
                signal: controller.signal,
            });
            // If we were aborted between resolution and here, swallow.
            if (controller.signal.aborted) return;
            setLoadState({ kind: "loaded", assets });
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                // Aborted — caller (refresh / unmount) initiated. Do nothing.
                return;
            }
            const message = err instanceof AssetCatalogError
                ? err.message
                : (err instanceof Error ? err.message : String(err));
            setLoadState({ kind: "error", message });
        }
    }, [ingestServiceUrl, fetchFn, limit]);

    // Mount-time fetch. Also re-fetches when ingestServiceUrl changes
    // (rare; the URL is derived from StreamConfig and is stable).
    useEffect(() => {
        void refresh();
        return () => {
            controllerRef.current?.abort();
        };
    }, [refresh]);

    const onLoadAsset = useCallback(async (asset: AssetSummary) => {
        if (activeSlug) return; // one load at a time — UX guard
        if (!channel) {
            setToast({
                kind: "failed",
                slug: asset.slug,
                reason: "stream not connected",
            });
            return;
        }
        setActiveSlug(asset.slug);
        setToast({ kind: "loading", slug: asset.slug });
        try {
            await channel.openAsset(asset.slug, undefined, asset.omniverse_url);
            setToast({ kind: "loaded", slug: asset.slug });
        } catch (err) {
            setToast({
                kind: "failed",
                slug: asset.slug,
                reason: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setActiveSlug(null);
        }
    }, [channel, activeSlug]);

    const dismissToast = useCallback(() => {
        setToast({ kind: "hidden" });
    }, []);

    const filteredAssets = useMemo<AssetSummary[]>(() => {
        if (loadState.kind !== "loaded") return [];
        if (!search) return loadState.assets;
        const needle = search.toLowerCase();
        return loadState.assets.filter((a) => a.slug.toLowerCase().includes(needle));
    }, [loadState, search]);

    // Collapsed: just the floating toggle pill.
    if (!expanded) {
        return (
            <div className="asset-browser-host" data-testid="asset-browser-host">
                <button
                    className="asset-browser-toggle"
                    data-testid="asset-browser-toggle"
                    onClick={() => setExpanded(true)}
                    title="Open asset browser"
                    aria-label="Open asset browser"
                >
                    <span className="asset-browser-toggle-icon" aria-hidden>📂</span>
                    Assets
                </button>
            </div>
        );
    }

    return (
        <div className="asset-browser-host" data-testid="asset-browser-host">
            <div className="asset-browser-panel" data-testid="asset-browser-panel">
                <div className="asset-browser-header">
                    <div className="asset-browser-header-row">
                        <div className="asset-browser-title">Assets</div>
                        <button
                            className="asset-browser-icon-button"
                            data-testid="asset-browser-refresh"
                            onClick={() => void refresh()}
                            title="Refresh asset list"
                            aria-label="Refresh asset list"
                        >
                            ⟳
                        </button>
                        <button
                            className="asset-browser-icon-button"
                            data-testid="asset-browser-collapse"
                            onClick={() => setExpanded(false)}
                            title="Collapse panel"
                            aria-label="Collapse panel"
                        >
                            ‹
                        </button>
                    </div>
                    <input
                        className="asset-browser-search"
                        data-testid="asset-browser-search"
                        type="text"
                        placeholder="Filter by slug…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                {toast.kind !== "hidden" && (
                    <AssetBrowserToast toast={toast} onDismiss={dismissToast} />
                )}

                <AssetBrowserBody
                    state={loadState}
                    filtered={filteredAssets}
                    search={search}
                    activeSlug={activeSlug}
                    onLoad={onLoadAsset}
                    onRetry={() => void refresh()}
                />
            </div>
        </div>
    );
}


// ---- Body subcomponent ---------------------------------------------------

function AssetBrowserBody({
    state,
    filtered,
    search,
    activeSlug,
    onLoad,
    onRetry,
}: {
    state: LoadState;
    filtered: AssetSummary[];
    search: string;
    activeSlug: string | null;
    onLoad: (a: AssetSummary) => void;
    onRetry: () => void;
}) {
    if (state.kind === "loading" || state.kind === "idle") {
        return (
            <div className="asset-browser-loading" data-testid="asset-browser-loading">
                Loading assets…
            </div>
        );
    }
    if (state.kind === "error") {
        return (
            <div className="asset-browser-error" data-testid="asset-browser-error">
                <div>Couldn't load assets</div>
                <div style={{ marginTop: 4, fontSize: 11 }}>{state.message}</div>
                <button
                    className="asset-browser-retry"
                    data-testid="asset-browser-retry"
                    onClick={onRetry}
                >
                    Retry
                </button>
            </div>
        );
    }
    // loaded
    if (state.assets.length === 0) {
        return (
            <div className="asset-browser-empty" data-testid="asset-browser-empty">
                <div className="asset-browser-empty-title">No assets ingested yet</div>
                <div className="asset-browser-empty-message">
                    Drop a file anywhere on the page to ingest your first asset.
                </div>
            </div>
        );
    }
    if (filtered.length === 0) {
        return (
            <div className="asset-browser-empty" data-testid="asset-browser-empty-search">
                <div className="asset-browser-empty-message">
                    No assets match <code>{search}</code>.
                </div>
            </div>
        );
    }
    return (
        <div className="asset-browser-list" data-testid="asset-browser-list">
            {filtered.map((a) => (
                <button
                    key={a.asset_id}
                    className={`asset-browser-card${activeSlug === a.slug ? " asset-browser-card-loading" : ""}`}
                    data-testid="asset-browser-card"
                    data-slug={a.slug}
                    onClick={() => onLoad(a)}
                    title={a.omniverse_url}
                    disabled={activeSlug !== null}
                >
                    <div className="asset-browser-card-slug">{a.slug}</div>
                    <div className="asset-browser-card-meta">
                        {a.source_format && (
                            <span className="asset-browser-card-format">{a.source_format}</span>
                        )}
                        {a.ingest_at && (
                            <span className="asset-browser-card-date">
                                {formatIngestDate(a.ingest_at)}
                            </span>
                        )}
                        {a.current_version > 1 && (
                            <span className="asset-browser-card-version">v{a.current_version}</span>
                        )}
                    </div>
                </button>
            ))}
        </div>
    );
}


// ---- Toast subcomponent --------------------------------------------------

function AssetBrowserToast({
    toast,
    onDismiss,
}: {
    toast: Exclude<ToastState, { kind: "hidden" }>;
    onDismiss: () => void;
}) {
    let testId: string;
    let cssClass = "asset-browser-toast";
    let body: React.ReactNode;
    switch (toast.kind) {
        case "loading":
            testId = "asset-browser-toast-loading";
            body = <>Loading <code>{toast.slug}</code>…</>;
            break;
        case "loaded":
            testId = "asset-browser-toast-loaded";
            cssClass += " asset-browser-toast-ok";
            body = <>Loaded <code>{toast.slug}</code></>;
            break;
        case "failed":
            testId = "asset-browser-toast-failed";
            cssClass += " asset-browser-toast-error";
            body = (
                <>
                    Failed to load <code>{toast.slug}</code>
                    <div style={{ marginTop: 2, fontSize: 11 }}>{toast.reason}</div>
                </>
            );
            break;
    }
    return (
        <div className={cssClass} data-testid={testId}>
            {body}
            <button
                className="asset-browser-toast-dismiss"
                data-testid="asset-browser-toast-dismiss"
                onClick={onDismiss}
                aria-label="Dismiss"
            >
                ×
            </button>
        </div>
    );
}


// ---- Helpers -------------------------------------------------------------

function formatIngestDate(iso: string): string {
    // Render date-only, locale-default format. ingest_at is ISO8601;
    // if it's malformed we surface the raw string so debugging is easy.
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString();
}
