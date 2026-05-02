/*
 * SwatchPanel — live-channel host for the slot list.
 *
 * Phase 1 Day 1 wiring:
 *   - On mount, takes an InputChannel (already configured against AppStream's
 *     send/receive surface).
 *   - Manual "Refresh" button fires material.query_slots over the channel
 *     and renders the response.
 *   - asset.opened auto-refresh subscription is wired today; lights up for
 *     free once the server emits (Day 2 contract §6).
 *
 * Phase 1 Day 2 (2026-05-01):
 *   - Server now emits asset.opened (extension's StageEventType.OPENED hook).
 *     The useEffect subscription below now fires `refresh()` on every
 *     emission — the manual Refresh button stays as an explicit affordance
 *     (force-reload after a Composer-side override was applied through a
 *     non-DATE path, or pre-asset.opened diagnostic mode).
 *   - The idle-state helper text updated to reflect that auto-refresh is
 *     live, not "landing later."
 *
 * Loading / error / empty states all visible — no spinner-eats-the-screen
 * failures.
 *
 * Ryan Takeda — Phase 1 Day 1 + Day 2, 2026-05-01.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { InputChannel } from "../../services/inputChannel";
import { ChannelError } from "../../services/inputChannel";
import type { MaterialSlot } from "../../services/inputChannelTypes";
import { SlotList } from "./SlotList";
import "./SwatchPanel.css";

export interface SwatchPanelProps {
    /** Live channel — host owns the lifecycle. May be null if the stream
     * isn't ready yet, in which case the panel renders a "waiting" state. */
    channel: InputChannel | null;

    /** Currently-open asset slug. SPA owns this (per contract §7); Day 1
     * the host hands a fixed string until ingest publishes asset.opened.
     * Pass null to disable the panel (no asset open). */
    assetId: string | null;
}

type LoadState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; slots: MaterialSlot[]; loadedAt: number }
    | { kind: "error"; code: string; message: string };

export function SwatchPanel({ channel, assetId }: SwatchPanelProps) {
    const [state, setState] = useState<LoadState>({ kind: "idle" });

    // Hold the latest assetId/channel in a ref so the auto-refresh
    // subscription doesn't re-bind every render.
    const refreshFnRef = useRef<() => void>(() => {});

    const refresh = useCallback(async () => {
        if (!channel || !assetId) return;
        setState({ kind: "loading" });
        try {
            const result = await channel.queryMaterialSlots(assetId);
            setState({
                kind: "ok",
                slots: result.slots,
                loadedAt: Date.now(),
            });
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            setState({ kind: "error", code: ce.code, message: ce.message });
        }
    }, [channel, assetId]);

    refreshFnRef.current = refresh;

    // Auto-refresh on asset.opened. Day 2 (2026-05-01): the extension now
    // emits this event on Kit's StageEventType.OPENED — see contract §6.
    // The handler indirects through refreshFnRef so the subscription
    // doesn't churn when assetId / channel change between renders.
    useEffect(() => {
        if (!channel) return;
        const unsubscribe = channel.onEvent("asset.opened", () => {
            refreshFnRef.current();
        });
        return unsubscribe;
    }, [channel]);

    // Cancel pending requests on unmount so a stream-disconnect mid-fetch
    // doesn't leave a stale resolve hanging. We don't cancel ALL channel
    // requests (other components may share this channel); we just let the
    // unmount kill any awaiters via the pending-promise rejection on
    // assetId / channel change above.

    if (!channel) {
        return (
            <div className="swatch-panel" data-testid="swatch-panel">
                <div className="swatch-panel-header">
                    <strong>Materials</strong>
                </div>
                <div className="swatch-panel-empty" data-testid="swatch-panel-disconnected">
                    Stream not connected — slot list unavailable.
                </div>
            </div>
        );
    }

    if (!assetId) {
        return (
            <div className="swatch-panel" data-testid="swatch-panel">
                <div className="swatch-panel-header">
                    <strong>Materials</strong>
                </div>
                <div className="swatch-panel-empty" data-testid="swatch-panel-no-asset">
                    No asset open. Open an asset to see its materials.
                </div>
            </div>
        );
    }

    return (
        <div className="swatch-panel" data-testid="swatch-panel">
            <div className="swatch-panel-header">
                <strong>Materials</strong>
                <button
                    data-testid="swatch-panel-refresh"
                    onClick={refresh}
                    disabled={state.kind === "loading"}
                >
                    {state.kind === "loading" ? "Loading…" : "Refresh"}
                </button>
            </div>

            {state.kind === "idle" && (
                <div className="swatch-panel-empty" data-testid="swatch-panel-idle">
                    Waiting for asset to load. Materials will populate
                    automatically when the kit fires <code>asset.opened</code>.
                    <br />
                    <small>
                        Press Refresh to force a query against the live stage
                        for <code>{assetId}</code>.
                    </small>
                </div>
            )}

            {state.kind === "loading" && (
                <div className="swatch-panel-empty" data-testid="swatch-panel-loading">
                    Querying material slots from the live stage…
                </div>
            )}

            {state.kind === "error" && (
                <div className="swatch-panel-error" data-testid="swatch-panel-error">
                    <div className="error-code">{state.code}</div>
                    <div className="error-message">{state.message}</div>
                    <button onClick={refresh}>Retry</button>
                </div>
            )}

            {state.kind === "ok" && (
                <SlotList slots={state.slots} assetId={assetId} />
            )}
        </div>
    );
}
