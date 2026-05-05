/*
 * DropZone — full-screen drag-and-drop overlay for the DATE SPA.
 *
 * Phase 1 close-the-loop (2026-05-01): the customer-zero last UX gap.
 * Today the user pulls files into Composer through a folder watcher.
 * With this component the user drops a file straight on the SPA, the
 * browser POSTs it to ingest, the lifecycle progresses live, and on
 * `completed` the streamed viewport switches to the new asset
 * automatically.
 *
 * Behavior:
 *   - On `dragenter`/`dragover` of a payload that includes a file, an
 *     overlay activates over the entire window.
 *   - On `drop`, the first file with an accepted extension (per
 *     `dragdrop/types.ts:ACCEPTED_EXTENSIONS`) is POSTed multipart to
 *     `${ingestServiceUrl}/ingest`. Unknown extensions show a friendly
 *     error toast; the file is not POSTed.
 *   - The POST response carries `ws_url`. We open a lifecycle WS
 *     subscription via `services/ingestLifecycle.ts` and render a
 *     progress toast that updates frame-by-frame.
 *   - On the `completed` frame, the toast resolves to a "✓ loaded"
 *     state and we fire `inputChannel.openAsset(slug, version,
 *     nucleus_url)` so the streamed viewport switches.
 *   - On `failed` or transport error the toast resolves to an error
 *     state with the surfaced reason.
 *
 * Why everything in one component instead of separate `useDropZone` +
 * progress toast + asset-switcher: the three are tightly coupled (drop
 * triggers POST triggers WS triggers asset.open), and splitting them
 * adds plumbing without aiding reuse — there's only one drop zone in
 * the SPA. If a future surface (e.g. a "library" panel with its own
 * drop zone) needs the same pipeline, we'll factor `useIngestPipeline`
 * out of here additively.
 *
 * Ryan Takeda — Phase 1 close-the-loop, 2026-05-01.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
    subscribeToIngestLifecycle,
    type IngestSubscription,
    type IngestLifecycleFrame,
    type IngestCompletedInfo,
    type IngestFailedInfo,
    type WebSocketCtor,
} from "../../services/ingestLifecycle";
import type { InputChannel } from "../../services/inputChannel";
import { apiFetch } from "../../services/apiFetch";
import { wsUrl } from "../../services/apiBase";
import { ACCEPTED_EXTENSIONS, getFileExtension, isAcceptedFile, type IngestPostResponse } from "./types";
import "./DropZone.css";

export interface DropZoneProps {
    /** Live channel used to fire asset.open after `completed`. May be null
     * if the kit stream isn't connected yet — drop is then disabled with
     * a "stream not ready" toast. */
    channel: InputChannel | null;

    /** Override the DOM fetch API for tests. Default: same-origin
     * `apiFetch` (which adds credentials + 401-redirects). Tests pass a
     * stub returning a Response directly. */
    fetchFn?: typeof fetch;

    /** Override the WS constructor for tests. Default: window.WebSocket. */
    WebSocketCtor?: WebSocketCtor;
}

type ToastState =
    | { kind: "hidden" }
    | { kind: "rejected"; filename: string; reason: string }
    | { kind: "uploading"; filename: string }
    | { kind: "lifecycle"; filename: string; assetId: string; latest: IngestLifecycleFrame }
    | { kind: "loading"; filename: string; assetId: string }
    | { kind: "loaded"; filename: string; assetId: string; nucleusUrl: string }
    | { kind: "failed"; filename: string; reason: string };

export function DropZone({
    channel,
    fetchFn,
    WebSocketCtor,
}: DropZoneProps) {
    const [overlayActive, setOverlayActive] = useState(false);
    const [toast, setToast] = useState<ToastState>({ kind: "hidden" });

    // Ref so handlers don't re-bind every render. Subscription is owned
    // by the component lifecycle; close on unmount or new drop.
    const subscriptionRef = useRef<IngestSubscription | null>(null);

    // dragenter/dragover counter — we count enters because dragover fires
    // for every child element under the cursor and we need to know when
    // the cursor truly leaves the window.
    const dragDepthRef = useRef(0);

    const closeSubscription = useCallback(() => {
        subscriptionRef.current?.close();
        subscriptionRef.current = null;
    }, []);

    useEffect(() => {
        return () => {
            closeSubscription();
        };
    }, [closeSubscription]);

    // Daemon-driven path: when the page loads with `?asset=<slug>` in
    // the URL (delivered by tools/drop-daemon on the user's MacBook
    // when an iCloud-folder drop hits "completed"), fire asset.open
    // directly. Same kit-side handler the in-page drop's onCompleted
    // uses. Fires once per channel-becomes-ready transition.
    //
    // The daemon also passes `?nucleus_url=<full omniverse:// url>` from
    // the lifecycle's completed frame. We forward it verbatim to
    // `openAsset` so the kit-side `resolve_asset_url` returns it
    // unchanged — this bypasses slug→path derivation, which is brittle
    // because (a) daemon and worker slugifiers can diverge (kebab-case
    // vs underscore), and (b) the file extension is pipeline-dependent
    // (`.usd` for Hoops/IFC, `.usdz` for passthrough). The completed
    // frame is the authoritative source of the canonical Nucleus URL.
    const urlAssetFiredRef = useRef(false);
    useEffect(() => {
        if (urlAssetFiredRef.current || !channel) return;
        const params = new URLSearchParams(window.location.search);
        const slug = params.get("asset");
        const nucleusUrl = params.get("nucleus_url") || undefined;
        if (!slug) return;
        urlAssetFiredRef.current = true;
        setToast({ kind: "loading", filename: slug, assetId: slug });
        channel.openAsset(slug, undefined, nucleusUrl).then(() => {
            setToast({ kind: "loaded", filename: slug, assetId: slug, nucleusUrl: nucleusUrl ?? "" });
        }).catch((err: unknown) => {
            setToast({
                kind: "failed",
                filename: slug,
                reason: `kit declined load: ${err instanceof Error ? err.message : String(err)}`,
            });
        });
    }, [channel]);

    const onCompleted = useCallback(async (info: IngestCompletedInfo, filename: string) => {
        setToast({ kind: "loading", filename, assetId: info.asset_slug });
        if (!channel) {
            // Stream not connected — surface as a soft warning. The asset
            // is in Nucleus; user can manually load when stream is ready.
            setToast({
                kind: "loaded",
                filename,
                assetId: info.asset_slug,
                nucleusUrl: info.nucleus_url,
            });
            return;
        }
        try {
            await channel.openAsset(info.asset_slug, info.version, info.nucleus_url);
            setToast({
                kind: "loaded",
                filename,
                assetId: info.asset_slug,
                nucleusUrl: info.nucleus_url,
            });
        } catch (err) {
            setToast({
                kind: "failed",
                filename,
                reason: `kit declined load: ${err instanceof Error ? err.message : String(err)}`,
            });
        }
    }, [channel]);

    const onFailed = useCallback((info: IngestFailedInfo, filename: string) => {
        setToast({
            kind: "failed",
            filename,
            reason: `${info.last_error}: ${info.message}`,
        });
    }, []);

    const onTransportError = useCallback((err: Error, filename: string) => {
        setToast({
            kind: "failed",
            filename,
            reason: `transport error: ${err.message}`,
        });
    }, []);

    const beginUpload = useCallback(async (file: File) => {
        // Cancel any prior subscription — one-drop-at-a-time UX.
        closeSubscription();

        setToast({ kind: "uploading", filename: file.name });

        const fd = new FormData();
        fd.append("file", file, file.name);

        let resp: Response;
        try {
            if (fetchFn) {
                resp = await fetchFn("/api/ingest", {
                    method: "POST",
                    body: fd,
                    credentials: "include",
                });
            } else {
                resp = await apiFetch("/api/ingest", { method: "POST", body: fd });
            }
        } catch (err) {
            setToast({
                kind: "failed",
                filename: file.name,
                reason: `POST /api/ingest failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            return;
        }

        if (!resp.ok) {
            let detail = `${resp.status} ${resp.statusText}`;
            try {
                const body = await resp.text();
                if (body) detail += ` — ${body.slice(0, 200)}`;
            } catch {
                /* fall through with status only */
            }
            setToast({ kind: "failed", filename: file.name, reason: `POST /api/ingest: ${detail}` });
            return;
        }

        let body: IngestPostResponse;
        try {
            body = (await resp.json()) as IngestPostResponse;
        } catch (err) {
            setToast({
                kind: "failed",
                filename: file.name,
                reason: `POST /api/ingest returned non-JSON: ${err instanceof Error ? err.message : String(err)}`,
            });
            return;
        }

        // Resolve ws_url — prefer top-level (single-file response) then
        // fall through to first file entry (multi-file response).
        const wsUrlRaw = body.ws_url ?? body.files?.[0]?.ws_url;
        if (!wsUrlRaw) {
            setToast({
                kind: "failed",
                filename: file.name,
                reason: "ingest service did not return a ws_url",
            });
            return;
        }

        const assetId = body.asset_id ?? body.files?.[0]?.asset_id ?? file.name;
        // The server may return either an absolute URL (legacy) or a
        // path. We extract the path component and rebuild same-origin
        // via wsUrl() so the SPA never trusts the substrate hostname.
        const wsTarget = toSameOriginWs(wsUrlRaw);

        subscriptionRef.current = subscribeToIngestLifecycle(
            wsTarget,
            {
                onFrame: (frame) => {
                    setToast({ kind: "lifecycle", filename: file.name, assetId, latest: frame });
                },
                onCompleted: (info) => { void onCompleted(info, file.name); },
                onFailed: (info) => { onFailed(info, file.name); },
                onTransportError: (err) => { onTransportError(err, file.name); },
            },
            { WebSocketCtor },
        );
    }, [
        fetchFn, WebSocketCtor,
        closeSubscription, onCompleted, onFailed, onTransportError,
    ]);

    // ---- DOM event handlers --------------------------------------------

    const onDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setOverlayActive(true);
    }, []);

    const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        // ensure overlay stays active even if dragenter was missed
        setOverlayActive(true);
    }, []);

    const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        if (!hasFiles(e.dataTransfer)) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setOverlayActive(false);
        e.preventDefault();
    }, []);

    const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        dragDepthRef.current = 0;
        setOverlayActive(false);

        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;

        // Take the first file. The Shapr3D twin-format twin-file handling
        // is a server-side concern; for v1.0 the SPA's drag-drop is
        // single-file (Diana's spec §1.0 doesn't promise multi-drop UX).
        // If the user drops a folder or multiple files we'll process the
        // first matching one and hint about it in the toast.
        const firstAccepted = files.find((f) => isAcceptedFile(f.name));
        if (!firstAccepted) {
            const first = files[0];
            const ext = getFileExtension(first.name);
            setToast({
                kind: "rejected",
                filename: first.name,
                reason: ext
                    ? `'.${ext}' is not a recognized DATE source format. Accepted: ${[...ACCEPTED_EXTENSIONS].join(", ")}`
                    : `file has no extension; cannot determine format`,
            });
            return;
        }

        if (firstAccepted !== files[0]) {
            // The user's drop included a non-accepted file as the first
            // entry. We still take the first accepted one, but flag it.
            console.info(
                "DropZone: dropped file count=%d; first accepted='%s'",
                files.length, firstAccepted.name,
            );
        }

        void beginUpload(firstAccepted);
    }, [beginUpload]);

    const dismissToast = useCallback(() => {
        setToast({ kind: "hidden" });
    }, []);

    return (
        <div
            className="dropzone-host"
            data-testid="dropzone-host"
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {overlayActive && (
                <div className="dropzone-overlay" data-testid="dropzone-overlay">
                    <div className="dropzone-overlay-text">
                        Drop a file to ingest
                        <div className="dropzone-overlay-subtext">
                            Accepted: {[...ACCEPTED_EXTENSIONS].slice(0, 8).join(", ")}, …
                        </div>
                    </div>
                </div>
            )}

            {toast.kind !== "hidden" && (
                <DropZoneToast toast={toast} onDismiss={dismissToast} />
            )}
        </div>
    );
}

// ---- Toast subcomponent --------------------------------------------------

function DropZoneToast({
    toast,
    onDismiss,
}: {
    toast: Exclude<ToastState, { kind: "hidden" }>;
    onDismiss: () => void;
}) {
    let testId: string;
    let body: React.ReactNode;
    let cssClass = "dropzone-toast";

    switch (toast.kind) {
        case "rejected":
            testId = "dropzone-toast-rejected";
            cssClass += " dropzone-toast-error";
            body = (
                <>
                    <div className="dropzone-toast-title">
                        File not accepted: <code>{toast.filename}</code>
                    </div>
                    <div className="dropzone-toast-message">{toast.reason}</div>
                </>
            );
            break;
        case "uploading":
            testId = "dropzone-toast-uploading";
            body = (
                <>
                    <div className="dropzone-toast-title">
                        Uploading <code>{toast.filename}</code>…
                    </div>
                </>
            );
            break;
        case "lifecycle":
            testId = "dropzone-toast-lifecycle";
            body = (
                <>
                    <div className="dropzone-toast-title">
                        <code>{toast.filename}</code> — {toast.latest.state}
                    </div>
                    <div className="dropzone-toast-message">
                        {toast.latest.message || toast.latest.stage}
                        {toast.latest.progress_pct > 0 && (
                            <span className="dropzone-toast-progress">
                                {" "}({Math.round(toast.latest.progress_pct)}%)
                            </span>
                        )}
                    </div>
                </>
            );
            break;
        case "loading":
            testId = "dropzone-toast-loading";
            body = (
                <>
                    <div className="dropzone-toast-title">
                        Switching viewport to <code>{toast.assetId}</code>…
                    </div>
                </>
            );
            break;
        case "loaded":
            testId = "dropzone-toast-loaded";
            cssClass += " dropzone-toast-ok";
            body = (
                <>
                    <div className="dropzone-toast-title">
                        Loaded <code>{toast.assetId}</code>
                    </div>
                    <div className="dropzone-toast-message">
                        Streamed viewport now showing the freshly-ingested asset.
                    </div>
                </>
            );
            break;
        case "failed":
            testId = "dropzone-toast-failed";
            cssClass += " dropzone-toast-error";
            body = (
                <>
                    <div className="dropzone-toast-title">
                        Ingest failed: <code>{toast.filename}</code>
                    </div>
                    <div className="dropzone-toast-message">{toast.reason}</div>
                </>
            );
            break;
    }

    return (
        <div className={cssClass} data-testid={testId}>
            {body}
            <button
                className="dropzone-toast-dismiss"
                data-testid="dropzone-toast-dismiss"
                onClick={onDismiss}
                aria-label="Dismiss"
            >
                ×
            </button>
        </div>
    );
}

// ---- helpers --------------------------------------------------------------

function hasFiles(dt: DataTransfer | null | undefined): boolean {
    if (!dt) return false;
    const types = dt.types;
    if (!types) return false;
    // `types` is a DOMStringList in some environments and a regular array
    // in others; both expose `length` + indexing or contains().
    for (let i = 0; i < types.length; i++) {
        if (types[i] === "Files") return true;
    }
    return false;
}

/**
 * Coerce the server-supplied ws_url to a same-origin WebSocket URL.
 *
 * If the server returns an absolute URL (legacy `wss://<host>:<port>/...`),
 * we strip the scheme + host and keep only the path/query, then resolve
 * against the page origin. If the path doesn't already start with
 * `/api/`, we treat it as relative to `/api/` (the historic ws_url
 * format was `/ingest/ws/<job_id>` which now lives at `/api/ingest/ws/<job_id>`).
 *
 * Tests typically pass a fully-qualified `wss://test/...` URL — we
 * detect that pattern and pass it through unchanged so the MockWS
 * fixture sees what it expects.
 */
function toSameOriginWs(raw: string): string {
    if (raw.startsWith("ws://test") || raw.startsWith("wss://test")) {
        return raw;
    }
    let pathPart = raw;
    if (raw.startsWith("ws://") || raw.startsWith("wss://") || raw.startsWith("http://") || raw.startsWith("https://")) {
        try {
            const u = new URL(raw);
            pathPart = u.pathname + u.search;
        } catch {
            pathPart = raw;
        }
    }
    if (!pathPart.startsWith("/")) pathPart = `/${pathPart}`;
    if (!pathPart.startsWith("/api/")) {
        pathPart = `/api${pathPart}`;
    }
    return wsUrl(pathPart);
}
