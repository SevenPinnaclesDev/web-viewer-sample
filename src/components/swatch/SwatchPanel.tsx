/*
 * SwatchPanel — live-channel host for the slot list + picker integration.
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
 *
 * Phase 1 picker sprint (2026-05-02):
 *   - Hosts MdlPicker. Click a slot row → picker opens for that slot.
 *     Selection checkboxes + "Pick for N" button → picker opens in bulk
 *     mode. On pick, fires material.set_override (single) or
 *     material.set_overrides_bulk (many) and shows a toast on success.
 *   - Caches the library catalog at component-level for the session;
 *     fetches lazily on first picker open.
 *   - Recently-used row in the picker is owned here (last 8 picks
 *     in-session) so it persists across multiple picker opens.
 *   - Edge cases handled:
 *     * Library empty (zero categories) — picker shows empty-state
 *     * Library fetch fails — picker shows error with retry
 *     * Apply fails — toast surfaces ChannelError code+message
 *     * Slot is overridden mid-pick (e.g. another viewer in lazy susan
 *       race) — set_override is idempotent at the contract level; the
 *       new value wins. Refresh on next asset.opened reflects truth.
 *
 * Loading / error / empty states all visible — no spinner-eats-the-screen
 * failures.
 *
 * Ryan Takeda — Phase 1 Day 1 + Day 2 + picker sprint, 2026-05-01 / 2026-05-02.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InputChannel } from "../../services/inputChannel";
import { ChannelError } from "../../services/inputChannel";
import type {
    LibraryCatalog,
    MaterialSlot,
} from "../../services/inputChannelTypes";
import { MdlPicker, type MdlPickerPick } from "../picker/MdlPicker";
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

    /** Picker sprint: optional Nucleus-hosted library root URL. Forwarded
     * verbatim to the picker (used to compose mdl_path). Defaults to the
     * MFO-DATE host when unspecified. */
    libraryRootUrl?: string;
}

type LoadState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; slots: MaterialSlot[]; loadedAt: number }
    | { kind: "error"; code: string; message: string };

type LibraryState =
    | { kind: "unfetched" }
    | { kind: "loading" }
    | { kind: "ok"; catalog: LibraryCatalog }
    | { kind: "error"; message: string };

type PickerTarget =
    | { kind: "single"; slot: MaterialSlot }
    | { kind: "bulk"; slots: MaterialSlot[] };

type ApplyToast =
    | { kind: "hidden" }
    | { kind: "applying"; mdlName: string; targetLabel: string }
    | { kind: "applied"; mdlName: string; targetLabel: string }
    | { kind: "failed"; mdlName: string; targetLabel: string; reason: string };

const MAX_RECENTLY_USED = 8;
const APPLY_TOAST_DURATION_MS = 2400;

export function SwatchPanel({ channel, assetId, libraryRootUrl }: SwatchPanelProps) {
    const [state, setState] = useState<LoadState>({ kind: "idle" });
    const [library, setLibrary] = useState<LibraryState>({ kind: "unfetched" });
    const [selectedSlotIds, setSelectedSlotIds] = useState<Set<string>>(() => new Set());
    const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
    const [recentlyUsed, setRecentlyUsed] = useState<MdlPickerPick[]>([]);
    const [toast, setToast] = useState<ApplyToast>({ kind: "hidden" });

    // Hold the latest assetId/channel in a ref so the auto-refresh
    // subscription doesn't re-bind every render.
    const refreshFnRef = useRef<() => void>(() => {});
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            // Clear stale selection and recently-used on asset switch —
            // they're scoped to the prior asset's slots / catalog.
            setSelectedSlotIds(new Set());
            refreshFnRef.current();
        });
        return unsubscribe;
    }, [channel]);

    // ---- library catalog ---------------------------------------------------

    const fetchLibrary = useCallback(async () => {
        if (!channel) return;
        setLibrary({ kind: "loading" });
        try {
            const catalog = await channel.listLibraryMaterials();
            setLibrary({ kind: "ok", catalog });
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            setLibrary({
                kind: "error",
                message: `${ce.code}: ${ce.message}`,
            });
        }
    }, [channel]);

    // ---- toast lifecycle ---------------------------------------------------

    const showToast = useCallback((next: ApplyToast) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(next);
        if (next.kind === "applied" || next.kind === "failed") {
            toastTimerRef.current = setTimeout(() => {
                setToast({ kind: "hidden" });
                toastTimerRef.current = null;
            }, APPLY_TOAST_DURATION_MS);
        }
    }, []);

    useEffect(() => {
        return () => {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        };
    }, []);

    // ---- picker open / close -----------------------------------------------

    const openPickerForSlot = useCallback((slot: MaterialSlot) => {
        setPickerTarget({ kind: "single", slot });
        if (library.kind === "unfetched") {
            void fetchLibrary();
        }
    }, [library.kind, fetchLibrary]);

    const slots = state.kind === "ok" ? state.slots : [];
    const selectedSlots = useMemo(() => {
        if (selectedSlotIds.size === 0) return [];
        return slots.filter((s) => selectedSlotIds.has(s.slot_id));
    }, [slots, selectedSlotIds]);

    const openPickerForSelection = useCallback(() => {
        if (selectedSlots.length === 0) return;
        setPickerTarget({ kind: "bulk", slots: selectedSlots });
        if (library.kind === "unfetched") {
            void fetchLibrary();
        }
    }, [selectedSlots, library.kind, fetchLibrary]);

    const closePicker = useCallback(() => setPickerTarget(null), []);

    // ---- pick → apply ------------------------------------------------------

    const recordRecentlyUsed = useCallback((pick: MdlPickerPick) => {
        setRecentlyUsed((prev) => {
            const without = prev.filter((p) => p.mdlPath !== pick.mdlPath);
            return [pick, ...without].slice(0, MAX_RECENTLY_USED);
        });
    }, []);

    const onPick = useCallback(async (pick: MdlPickerPick) => {
        if (!channel || !assetId || !pickerTarget) {
            // Defensive — picker shouldn't be open without these. Close it.
            setPickerTarget(null);
            return;
        }
        const target = pickerTarget;
        // Close the picker synchronously (single-click apply + close per
        // picker-ui-v1.md §"Decisions for Ryan to make" #5).
        setPickerTarget(null);

        const targetLabel =
            target.kind === "single"
                ? target.slot.display_name || target.slot.source_name
                : `${target.slots.length} slots`;
        showToast({ kind: "applying", mdlName: pick.displayName, targetLabel });

        try {
            if (target.kind === "single") {
                await channel.setMaterialOverride(assetId, target.slot.slot_id, pick.mdlPath);
                showToast({ kind: "applied", mdlName: pick.displayName, targetLabel });
            } else {
                const slotIds = target.slots.map((s) => s.slot_id);
                const result = await channel.setMaterialOverridesBulk(assetId, slotIds, pick.mdlPath);
                if (result.skipped.length > 0) {
                    showToast({
                        kind: "failed",
                        mdlName: pick.displayName,
                        targetLabel,
                        reason: `${result.applied.length}/${slotIds.length} applied; ${result.skipped.length} skipped`,
                    });
                } else {
                    showToast({ kind: "applied", mdlName: pick.displayName, targetLabel });
                }
            }
            recordRecentlyUsed(pick);
            // Optimistically reflect override state in the slot list. A
            // subsequent asset.opened or manual Refresh re-syncs from the
            // live stage (which is the source of truth).
            setState((prev) => {
                if (prev.kind !== "ok") return prev;
                const targetIds = new Set(
                    target.kind === "single"
                        ? [target.slot.slot_id]
                        : target.slots.map((s) => s.slot_id),
                );
                return {
                    ...prev,
                    slots: prev.slots.map((s) =>
                        targetIds.has(s.slot_id)
                            ? { ...s, is_overridden: true, current_mdl_path: pick.mdlPath }
                            : s,
                    ),
                };
            });
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            showToast({
                kind: "failed",
                mdlName: pick.displayName,
                targetLabel,
                reason: `${ce.code}: ${ce.message}`,
            });
        }
    }, [channel, assetId, pickerTarget, showToast, recordRecentlyUsed]);

    // ---- empty-state guards ------------------------------------------------

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

    // ---- picker props ------------------------------------------------------

    const targetSlots: MaterialSlot[] =
        pickerTarget?.kind === "single"
            ? [pickerTarget.slot]
            : pickerTarget?.kind === "bulk"
            ? pickerTarget.slots
            : [];

    const pickerCatalog = library.kind === "ok" ? library.catalog : null;
    const pickerLoadError = library.kind === "error" ? library.message : null;

    return (
        <div className="swatch-panel" data-testid="swatch-panel">
            <div className="swatch-panel-header">
                <strong>Materials</strong>
                {selectedSlotIds.size > 0 && (
                    <button
                        className="swatch-panel-bulk-pick"
                        data-testid="swatch-panel-bulk-pick"
                        onClick={openPickerForSelection}
                    >
                        Pick for {selectedSlotIds.size} selected
                    </button>
                )}
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
                <SlotList
                    slots={state.slots}
                    assetId={assetId}
                    onSlotPick={openPickerForSlot}
                    selectedSlotIds={selectedSlotIds}
                    onSelectionChange={setSelectedSlotIds}
                />
            )}

            <MdlPicker
                open={pickerTarget !== null}
                targetSlots={targetSlots}
                catalog={pickerCatalog}
                loadError={pickerLoadError}
                onRetryFetch={fetchLibrary}
                onPick={onPick}
                onDismiss={closePicker}
                recentlyUsed={recentlyUsed}
                libraryRootUrl={libraryRootUrl}
            />

            {toast.kind !== "hidden" && (
                <SwatchPanelToast toast={toast} onDismiss={() => setToast({ kind: "hidden" })} />
            )}
        </div>
    );
}

// ---- Toast subcomponent --------------------------------------------------

function SwatchPanelToast({
    toast,
    onDismiss,
}: {
    toast: Exclude<ApplyToast, { kind: "hidden" }>;
    onDismiss: () => void;
}) {
    let testId: string;
    let cssClass = "swatch-panel-toast";
    let body: React.ReactNode;

    switch (toast.kind) {
        case "applying":
            testId = "swatch-panel-toast-applying";
            body = (
                <>
                    <div className="swatch-panel-toast-title">
                        Applying <code>{toast.mdlName}</code>…
                    </div>
                    <div className="swatch-panel-toast-message">
                        Target: <code>{toast.targetLabel}</code>
                    </div>
                </>
            );
            break;
        case "applied":
            testId = "swatch-panel-toast-applied";
            cssClass += " swatch-panel-toast-ok";
            body = (
                <>
                    <div className="swatch-panel-toast-title">
                        Applied <code>{toast.mdlName}</code>
                    </div>
                    <div className="swatch-panel-toast-message">
                        to <code>{toast.targetLabel}</code>
                    </div>
                </>
            );
            break;
        case "failed":
            testId = "swatch-panel-toast-failed";
            cssClass += " swatch-panel-toast-error";
            body = (
                <>
                    <div className="swatch-panel-toast-title">
                        Apply failed: <code>{toast.mdlName}</code>
                    </div>
                    <div className="swatch-panel-toast-message">{toast.reason}</div>
                </>
            );
            break;
    }

    return (
        <div className={cssClass} data-testid={testId}>
            {body}
            <button
                className="swatch-panel-toast-dismiss"
                data-testid="swatch-panel-toast-dismiss"
                onClick={onDismiss}
                aria-label="Dismiss"
            >
                ×
            </button>
        </div>
    );
}
