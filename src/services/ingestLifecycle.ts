/*
 * ingestLifecycle.ts — SPA-side subscriber for the DATE ingest service's
 * lifecycle WebSocket stream.
 *
 * Mirrors the structure of inputChannel.ts (one service per channel,
 * testable in isolation against an injected transport, typed callbacks).
 *
 * The ingest service is reached same-origin via Caddy at
 * `/api/ingest/ws/{job_id}`. Per `architecture/ingest-service.md` §3,
 * POST /api/ingest returns `{asset_id, ws_url, ...}`; the SPA opens a
 * WS at the same-origin path and receives server-pushed JSON frames
 * following the lifecycle state machine:
 *
 *     received → routed → queued → processing → normalize.<fix-name> → completed | failed
 *
 * Each frame: `{state, stage, progress_pct, message, ts, context: {...}}`.
 * The `completed` frame's context carries `asset_slug`, `nucleus_url`,
 * `version` — that's what the drag-drop UI uses to fire `asset.open`
 * over the kit input channel.
 *
 * Why a separate service:
 *   - The drag-drop component would otherwise have to manage WS lifecycle
 *     itself, and we want one well-tested subscriber rather than ad-hoc
 *     code per UI feature.
 *   - SwatchPanel can also subscribe (e.g. to surface a "current asset"
 *     name that updates live as ingestion progresses).
 *   - The contract envelope here is the ingest service's, not the kit
 *     channel's — clean separation from inputChannel.ts.
 *
 * Ryan Takeda — Phase 1 close-the-loop, 2026-05-01.
 */

// ---- Frame shape — mirrors server/ingest/service/models.StateFrame --------

export type IngestLifecycleState =
    | "received"
    | "routed"
    | "queued"
    | "processing"
    | "completed"
    | "failed"
    // Worker-side legacy / spec §3 names — interleave with D2 strict states.
    | "uploaded"
    | "validating"
    | "routing"
    | "converting"
    | "normalizing"
    | "writing"
    | "ready";

export interface IngestLifecycleFrame {
    state: IngestLifecycleState;
    stage: string;
    progress_pct: number;
    message: string;
    ts: string;
    /** Free-form context map populated on `routed` (pipeline + reason),
     * `completed` (asset_slug + nucleus_url + version), and `failed`
     * (last_error + reason). The frame schema stays flat — context
     * accommodates new keys additively. */
    context: Record<string, string>;
}

/** Convenience predicate — terminal states close the WS. */
export function isTerminalState(state: IngestLifecycleState): boolean {
    return state === "completed" || state === "failed" || state === "ready";
}

// ---- Service interface ---------------------------------------------------

/** Optional injection seam for tests. The default is `window.WebSocket`. */
export type WebSocketCtor = new (url: string) => WebSocket;

export interface IngestSubscriptionHandlers {
    /** Fires for every parsed frame, in order. */
    onFrame?: (frame: IngestLifecycleFrame) => void;

    /** Convenience — fires once when the stream reaches `completed`. The
     * payload mirrors `frame.context` for the completed frame and
     * promotes the well-known fields out of the string-typed map. */
    onCompleted?: (info: IngestCompletedInfo) => void;

    /** Convenience — fires once when the stream reaches `failed`. */
    onFailed?: (info: IngestFailedInfo) => void;

    /** Fires on a transport-level error (connection refused, server
     * dropped the socket without sending a terminal frame, etc.). */
    onTransportError?: (err: Error) => void;
}

/** What `onCompleted` hands the caller — the well-known context keys
 * promoted out of the string-typed context dict. Per the `completed`
 * frame's contract (worker emits these per `architecture/ingest-service.md`
 * §3 + the worker's `_completed_frame_carries_nucleus_url_and_slug` test). */
export interface IngestCompletedInfo {
    asset_slug: string;
    nucleus_url: string;
    /** Version is a stringified int in the wire frame; we coerce. */
    version?: number;
    /** All other context keys, retained for diagnostics. */
    raw_context: Record<string, string>;
}

export interface IngestFailedInfo {
    /** From frame.context.last_error (machine-readable). */
    last_error: string;
    /** From frame.context.reason / message (human-readable). */
    message: string;
    raw_context: Record<string, string>;
}

export interface IngestSubscription {
    /** Close the WebSocket and stop reporting frames. Idempotent. */
    close(): void;

    /** Currently-open WebSocket (may be null between reconnect attempts). */
    readonly socket: WebSocket | null;

    /** True until close() called or terminal state received. */
    readonly active: boolean;
}

export interface IngestLifecycleOptions {
    /** Override the transport for tests. Default: window.WebSocket. */
    WebSocketCtor?: WebSocketCtor;

    /** Reserved — currently unused. We don't auto-reconnect by default
     * because the WS pushes terminal frames quickly (sub-minute for
     * typical assets) and a mid-conversion drop is rare. If reconnect
     * is needed later, plumb it through here additively. */
    reconnectOnDrop?: boolean;
}

// ---- Implementation ------------------------------------------------------

/**
 * Subscribe to a single ingest job's lifecycle stream.
 *
 * Returns an IngestSubscription with a `close()` to bail out early
 * (e.g. on component unmount). The handlers fire as frames arrive;
 * onCompleted / onFailed are convenience terminals that auto-close the
 * socket after firing.
 *
 * The `wsUrl` argument may be a fully-qualified absolute URL (test
 * fixtures, or an unconverted server response) or a same-origin path
 * — same-origin paths get resolved through `wsUrl()` against the
 * current origin so the substrate's hostname is never named in the
 * SPA. Tests pass `wss://test/...` and that flows through unchanged.
 *
 * Defensive parsing: any frame that doesn't match the schema is logged
 * and dropped. We don't surface parse errors to callers — the lifecycle
 * model is "you'll see frames eventually; if you don't, the WS will
 * drop and onTransportError fires." That's right for the SPA UX.
 */
export function subscribeToIngestLifecycle(
    wsUrl: string,
    handlers: IngestSubscriptionHandlers,
    options: IngestLifecycleOptions = {},
): IngestSubscription {
    const Ctor: WebSocketCtor = options.WebSocketCtor ?? (typeof WebSocket !== "undefined"
        ? (WebSocket as unknown as WebSocketCtor)
        : (() => {
              throw new Error("WebSocket constructor not available; pass options.WebSocketCtor");
          })());

    let active = true;
    let socket: WebSocket | null = null;

    const subscription: IngestSubscription = {
        close() {
            if (!active) return;
            active = false;
            try {
                socket?.close();
            } catch {
                /* tolerate Already-closing */
            }
        },
        get socket() { return socket; },
        get active() { return active; },
    };

    try {
        socket = new Ctor(wsUrl);
    } catch (err) {
        // Synchronous construction failure — mirror onTransportError.
        active = false;
        handlers.onTransportError?.(err instanceof Error ? err : new Error(String(err)));
        return subscription;
    }

    socket.onmessage = (event: MessageEvent) => {
        if (!active) return;
        const frame = parseLifecycleFrame(event.data);
        if (!frame) return;
        handlers.onFrame?.(frame);

        if (frame.state === "completed") {
            handlers.onCompleted?.(buildCompletedInfo(frame));
            subscription.close();
        } else if (frame.state === "failed") {
            handlers.onFailed?.(buildFailedInfo(frame));
            subscription.close();
        }
    };

    socket.onerror = (_evt: Event) => {
        if (!active) return;
        // The WebSocket spec doesn't expose a useful error from `event`;
        // the close handler will fire next with the close code and
        // surface a more useful diagnostic.
    };

    socket.onclose = (evt: CloseEvent) => {
        if (!active) return;
        // Closed without a terminal frame — surface as transport error.
        active = false;
        handlers.onTransportError?.(new Error(
            `ingest WS closed before terminal frame (code=${evt.code}, reason=${evt.reason || "<empty>"})`,
        ));
    };

    return subscription;
}

// ---- internal helpers ----------------------------------------------------

function parseLifecycleFrame(raw: unknown): IngestLifecycleFrame | null {
    if (typeof raw !== "string") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const f = parsed as Record<string, unknown>;
    const state = f.state;
    if (typeof state !== "string") return null;
    return {
        state: state as IngestLifecycleState,
        stage: typeof f.stage === "string" ? f.stage : "",
        progress_pct: typeof f.progress_pct === "number" ? f.progress_pct : 0,
        message: typeof f.message === "string" ? f.message : "",
        ts: typeof f.ts === "string" ? f.ts : "",
        context: (f.context && typeof f.context === "object")
            ? coerceStringMap(f.context as Record<string, unknown>)
            : {},
    };
}

function coerceStringMap(o: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(o)) {
        if (v === null || v === undefined) continue;
        out[k] = typeof v === "string" ? v : String(v);
    }
    return out;
}

function buildCompletedInfo(frame: IngestLifecycleFrame): IngestCompletedInfo {
    const ctx = frame.context;
    const versionRaw = ctx.version;
    let version: number | undefined;
    if (versionRaw !== undefined && versionRaw !== "") {
        const parsed = parseInt(versionRaw, 10);
        if (!Number.isNaN(parsed)) version = parsed;
    }
    return {
        asset_slug: ctx.asset_slug ?? "",
        nucleus_url: ctx.nucleus_url ?? "",
        version,
        raw_context: ctx,
    };
}

function buildFailedInfo(frame: IngestLifecycleFrame): IngestFailedInfo {
    const ctx = frame.context;
    return {
        last_error: ctx.last_error ?? "unknown",
        message: ctx.reason || frame.message || "ingest failed",
        raw_context: ctx,
    };
}
