/*
 * inputChannel.ts — SPA-side wrapper for input_channel_v1.
 *
 * Sends contract-shaped (§4.1) request frames over AppStream's underlying
 * data channel and correlates responses by `id`. Listeners receive
 * unsolicited (§4.3) event frames.
 *
 * Why a separate service instead of bolting directly onto AppStream:
 *   - The Window.tsx _handleCustomEvent() switch handles legacy
 *     `event_type`-shaped messages (openedStageResult, getChildrenResponse,
 *     etc.). We don't want to touch that surface — it's NVIDIA sample-app
 *     code. Instead, we add an early branch in Window.tsx that hands
 *     contract-shaped frames to InputChannel.handleFrame() before falling
 *     through to the legacy switch.
 *   - This service is testable in isolation: it takes a `send` callback
 *     and lets us drive `handleFrame` from a mock to verify request/
 *     response correlation, timeout behavior, error envelopes.
 *
 * Day 1: only material.query_slots is used in anger. The class is shaped
 * to take any contract command — Day 2 wires set_override etc. through
 * the same path with no service-side changes.
 *
 * Ryan Takeda — Phase 1 Day 1, 2026-05-01.
 */
import type {
    ChannelRequest,
    ChannelEvent,
    LibraryCatalog,
    OpenAssetRequest,
    OpenAssetResult,
    QuerySlotsResult,
    SetOverridesBulkResult,
} from "./inputChannelTypes";

export type SendFn = (jsonText: string) => void;
export type EventHandler = (event: ChannelEvent) => void;

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (reason: ChannelError) => void;
    command: string;
    issuedAt: number;
    timeoutId: ReturnType<typeof setTimeout> | null;
}

export class ChannelError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "ChannelError";
        this.code = code;
    }
}

export interface InputChannelOptions {
    /** Default per-request timeout (ms). The contract has no timeout
     * mandate; the SPA-side timeout is purely UX (a hung kit shouldn't
     * leave the user staring at a spinner forever). */
    defaultTimeoutMs?: number;
}

/**
 * Generate a UUIDv4 for request `id`. Falls back to a Math.random hex if
 * crypto.randomUUID isn't available (unlikely on modern browsers, but
 * the AppStream library targets very old environments occasionally).
 */
function generateRequestId(): string {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    // RFC 4122 v4 fallback (good enough for correlation, not crypto).
    const r = (n: number) => Math.floor(Math.random() * (1 << n));
    const hex = (n: number) => r(n).toString(16).padStart(Math.ceil(n / 4), "0");
    return `${hex(32)}-${hex(16)}-4${hex(12)}-${(8 + r(2)).toString(16)}${hex(12)}-${hex(48)}`;
}

export class InputChannel {
    private pending = new Map<string, PendingRequest>();
    private eventHandlers = new Map<string, Set<EventHandler>>();
    private send: SendFn;
    private defaultTimeoutMs: number;

    constructor(send: SendFn, opts: InputChannelOptions = {}) {
        this.send = send;
        this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 8_000;
    }

    /**
     * Replace the underlying send fn. Useful when AppStream connects
     * after the channel is constructed; the host can swap in the live
     * sender once the stream becomes ready.
     */
    setSender(send: SendFn): void {
        this.send = send;
    }

    /**
     * Send a contract command, return a Promise that resolves with the
     * `result` on success or rejects with ChannelError on failure /
     * timeout. Throws synchronously only on serialization failure.
     */
    request<T = unknown>(command: string, payload: unknown, timeoutMs?: number): Promise<T> {
        const id = generateRequestId();
        const frame: ChannelRequest = { id, command, payload };
        const json = JSON.stringify(frame);

        return new Promise<T>((resolve, reject) => {
            const t = timeoutMs ?? this.defaultTimeoutMs;
            const timeoutId = t > 0 ? setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new ChannelError(
                        "spa_timeout",
                        `request '${command}' timed out after ${t}ms (no response from kit)`,
                    ));
                }
            }, t) : null;
            this.pending.set(id, {
                resolve: resolve as (value: unknown) => void,
                reject,
                command,
                issuedAt: Date.now(),
                timeoutId,
            });
            try {
                this.send(json);
            } catch (err) {
                this.pending.delete(id);
                if (timeoutId) clearTimeout(timeoutId);
                reject(new ChannelError(
                    "spa_send_failed",
                    `failed to send: ${err instanceof Error ? err.message : String(err)}`,
                ));
            }
        });
    }

    /**
     * Subscribe to an event namespace. Returns an unsubscribe function.
     * Day 1 has no events fired; the API exists so SwatchPanel can wire
     * `asset.opened` once Day 2 server-side fires it.
     */
    onEvent(eventName: string, handler: EventHandler): () => void {
        let bucket = this.eventHandlers.get(eventName);
        if (!bucket) {
            bucket = new Set();
            this.eventHandlers.set(eventName, bucket);
        }
        bucket.add(handler);
        return () => {
            const b = this.eventHandlers.get(eventName);
            if (b) {
                b.delete(handler);
                if (b.size === 0) this.eventHandlers.delete(eventName);
            }
        };
    }

    /**
     * Receive a frame off the underlying transport. Returns true if the
     * frame was a contract frame (handled), false otherwise — the caller
     * (Window.tsx) uses the return to know whether to also pass the frame
     * to the legacy event_type handler.
     */
    handleFrame(frame: unknown): boolean {
        if (!frame || typeof frame !== "object") return false;
        const f = frame as Record<string, unknown>;

        // Event frame (§4.3) — has `event` key, no `id`.
        if (typeof f.event === "string" && !("id" in f)) {
            const evt: ChannelEvent = {
                event: f.event,
                payload: (f.payload as Record<string, unknown>) ?? {},
            };
            const handlers = this.eventHandlers.get(evt.event);
            if (handlers) for (const h of handlers) h(evt);
            return true;
        }

        // Response frame (§4.2) — has `id` and `ok`.
        if (typeof f.id === "string" && "ok" in f) {
            const id = f.id as string;
            const pending = this.pending.get(id);
            if (!pending) {
                // Late response (after timeout) or duplicate — drop.
                return true;
            }
            this.pending.delete(id);
            if (pending.timeoutId) clearTimeout(pending.timeoutId);

            const ok = f.ok === true;
            if (ok) {
                pending.resolve(f.result ?? {});
            } else {
                const err = (f.error as Record<string, unknown>) ?? {};
                const code = typeof err.code === "string" ? err.code : "kit_internal";
                const message = typeof err.message === "string" ? err.message : "unknown error";
                pending.reject(new ChannelError(code, message));
            }
            return true;
        }

        return false; // legacy event_type frame or otherwise unrecognized
    }

    /** Diagnostics — count of in-flight requests. */
    get inflightCount(): number {
        return this.pending.size;
    }

    /**
     * Cancel everything in flight (e.g. on disconnect). Pending requests
     * reject with code `spa_cancelled` so callers can show a "stream
     * disconnected" message.
     */
    cancelAll(reason = "stream disconnected"): void {
        for (const [, pending] of this.pending) {
            if (pending.timeoutId) clearTimeout(pending.timeoutId);
            pending.reject(new ChannelError("spa_cancelled", reason));
        }
        this.pending.clear();
    }

    // ---- typed convenience wrappers for the locked material commands -----
    // Day 2-4 commands return-type-narrow as their stubs come online.

    queryMaterialSlots(assetId: string): Promise<QuerySlotsResult> {
        return this.request<QuerySlotsResult>("material.query_slots", { asset_id: assetId });
    }

    setMaterialOverride(assetId: string, slotId: string, mdlPath: string): Promise<{}> {
        return this.request<{}>("material.set_override", {
            asset_id: assetId,
            slot_id: slotId,
            mdl_path: mdlPath,
        });
    }

    resetMaterialOverride(assetId: string, slotId: string): Promise<{}> {
        return this.request<{}>("material.reset_override", {
            asset_id: assetId,
            slot_id: slotId,
        });
    }

    clearAllMaterialOverrides(assetId: string): Promise<{}> {
        return this.request<{}>("material.clear_all_overrides", { asset_id: assetId });
    }

    setMaterialOverridesBulk(
        assetId: string,
        slotIds: string[],
        mdlPath: string,
    ): Promise<SetOverridesBulkResult> {
        return this.request<SetOverridesBulkResult>("material.set_overrides_bulk", {
            asset_id: assetId,
            slot_ids: slotIds,
            mdl_path: mdlPath,
        });
    }

    /**
     * Phase 1 close-the-loop (2026-05-01): ask the kit extension to load
     * a new asset on the streamed viewport. Returns once the extension
     * has acknowledged the load *request* — the actual `asset.opened`
     * event lands later via the channel's event surface (see
     * SwatchPanel's onEvent('asset.opened') subscription).
     *
     * This is the auto-fire target on the ingest pipeline's `completed`
     * lifecycle frame: when ingest writes a freshly-converted asset to
     * Nucleus, the SPA fires this with the `nucleus_url` from the
     * `completed` frame's context, and the streamed viewport switches.
     *
     * @param assetId  the asset slug (e.g. "compass_step")
     * @param version  optional version (omit to target `current` symlink)
     * @param nucleusUrl  optional fully-resolved URL — kit honors verbatim
     */
    openAsset(assetId: string, version?: number, nucleusUrl?: string): Promise<OpenAssetResult> {
        const payload: OpenAssetRequest = { asset_id: assetId };
        if (version !== undefined) payload.version = version;
        if (nucleusUrl !== undefined) payload.nucleus_url = nucleusUrl;
        return this.request<OpenAssetResult>("asset.open", payload);
    }

    /**
     * Picker sprint (2026-05-02): fetch the MDL library catalog from
     * Nucleus. The kit extension reads metadata.json off
     * `omniverse://nucleus.<deployment>/DATE/Library/Materials/` via
     * omni.client and returns the parsed catalog.
     *
     * The MDL Picker calls this on first open and caches the result in
     * component-level state for the session — re-fetch is via an explicit
     * refresh action (manual page reload at v1; in-component refresh
     * button is v1.5).
     *
     * Errors per the kit-side handler:
     *  - `library_not_found` — catalog file missing on Nucleus (curator
     *    hasn't been run, or wrong library path)
     *  - `library_parse_error` — catalog malformed (curator bug, or
     *    out-of-band edit corrupted the file)
     *  - `kit_internal` — anything else (transport, omni.client errors)
     */
    listLibraryMaterials(): Promise<LibraryCatalog> {
        return this.request<LibraryCatalog>("library.list_materials", {});
    }
}
