/*
 * ViewportPickHandler — tap-to-pick on the streamed viewport.
 *
 * Why this exists: the picker UI (clients/web/design/picker-ui-v1.md) ships
 * with one invocation path — click a slot row in SwatchPanel. Tap-to-pick
 * adds the SECOND path: tap a surface in the streaming viewport, kit
 * raycasts and returns the slot bound to the prim under the tap, the SPA
 * opens the picker pre-populated with that slot, single-click to apply,
 * the wall changes color live.
 *
 * That's Jim's customer-zero centerpiece (CoffeeWithJim 2026-05-03):
 * "I touch a wall, I pick a material, the wall changes." This component
 * is the SPA half of that primitive.
 *
 * Modifier-key vs toggle decision (2026-05-04):
 *   We chose a TOGGLE BUTTON as the primary affordance because:
 *   - Customer-zero target is iPad streamed (per CoffeeWithJim 2026-05-03);
 *     touch devices have no Cmd/Ctrl modifier
 *   - Toggle is discoverable without UI tutorials
 *   - We *also* honor Cmd/Ctrl-click on Mac/PC as a bonus power-user shortcut
 *     that always works regardless of toggle state — zero cost to add
 *
 * Pick-mode UX:
 *   - Toggle off (default): clicks fall through to AppStream (orbit/pan).
 *     Cmd/Ctrl-click anywhere on the wrapper still triggers a pick.
 *   - Toggle on: a transparent overlay captures all clicks; pick fires;
 *     overlay stays active (operator can pick repeatedly, e.g. compare
 *     materials across walls). Esc or clicking the toggle exits.
 *
 * Catalog caching: the picker needs the library catalog. We fetch lazily
 * on first picker-open and cache in component state for the session.
 * Note this is a SEPARATE cache from SwatchPanel's — the two contexts may
 * mount independently (StreamOnlyWindow has no SwatchPanel; Window.tsx
 * has both). Keeping them separate is fine at v1 — the catalog is small.
 *
 * The AppStream control surface is hostile to React event ergonomics: it
 * mounts a full-screen video element with its own pointer-event handlers.
 * Rather than fight it, we render a SIBLING overlay positioned absolutely
 * over the streaming wrapper. CSS `pointer-events` toggles per pick mode.
 *
 * Ryan Takeda — Phase 1 picker sprint follow-up, 2026-05-04.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChannelError, type InputChannel } from "../../services/inputChannel";
import type {
    LibraryCatalog,
    PickSlotResult,
} from "../../services/inputChannelTypes";
import {
    MdlPicker,
    type MdlPickerPick,
} from "../picker/MdlPicker";
import "./ViewportPickHandler.css";

export interface ViewportPickHandlerProps {
    /** Live channel — host owns the lifecycle; we don't reconnect. May be
     * null if the stream isn't ready yet, in which case pick mode is
     * disabled (toggle disabled, modifier-clicks no-op). */
    channel: InputChannel | null;

    /** Currently-open asset slug. The kit-side pick command needs this
     * (well, kit owns the asset_id; the picker's apply path needs it for
     * material.set_override). Pass null to disable picking entirely. */
    assetId: string | null;

    /** Optional Nucleus-hosted library root URL — passed through to the
     * picker for mdl_path composition. Defaults to MFO-DATE. */
    libraryRootUrl?: string;

    /** Optional ref to the streaming canvas wrapper. We measure its
     * bounding rect for click→[0..1] normalization. If omitted we fall
     * back to the document body's rect (correct in StreamOnlyWindow where
     * the streaming element fills the viewport). */
    streamWrapperRef?: React.RefObject<HTMLDivElement | null>;
}

type LibraryState =
    | { kind: "unfetched" }
    | { kind: "loading" }
    | { kind: "ok"; catalog: LibraryCatalog }
    | { kind: "error"; message: string };

type PickerTarget = {
    slot: PickSlotResult;
};

type Toast =
    | { kind: "hidden" }
    | { kind: "info"; message: string }
    | { kind: "applying"; mdlName: string; targetLabel: string }
    | { kind: "applied"; mdlName: string; targetLabel: string }
    | { kind: "failed"; message: string };

const TOAST_DURATION_MS = 2400;
const MAX_RECENTLY_USED = 8;

/**
 * Compute normalized [0..1] viewport coords from a click event + bounding
 * rect. Returns null if the click was outside the rect (defensive — most
 * pointerdown events on a hosted overlay arrive inside; mouse-released
 * outside-the-window can produce odd coords).
 */
export function computeNormalizedCoords(
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
): { xNorm: number; yNorm: number } | null {
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { xNorm: x, yNorm: y };
}

export function ViewportPickHandler({
    channel,
    assetId,
    libraryRootUrl,
    streamWrapperRef,
}: ViewportPickHandlerProps) {
    const [pickModeOn, setPickModeOn] = useState(false);
    const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
    const [library, setLibrary] = useState<LibraryState>({ kind: "unfetched" });
    const [recentlyUsed, setRecentlyUsed] = useState<MdlPickerPick[]>([]);
    const [toast, setToast] = useState<Toast>({ kind: "hidden" });

    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // ---- toast lifecycle ---------------------------------------------------

    const showToast = useCallback((next: Toast) => {
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        setToast(next);
        if (next.kind === "applied" || next.kind === "failed" || next.kind === "info") {
            toastTimerRef.current = setTimeout(() => {
                setToast({ kind: "hidden" });
                toastTimerRef.current = null;
            }, TOAST_DURATION_MS);
        }
    }, []);

    useEffect(() => {
        return () => {
            if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        };
    }, []);

    // ---- library fetch -----------------------------------------------------

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
            setLibrary({ kind: "error", message: `${ce.code}: ${ce.message}` });
        }
    }, [channel]);

    // ---- the pick itself ---------------------------------------------------

    const performPick = useCallback(async (xNorm: number, yNorm: number) => {
        if (!channel || !assetId) {
            showToast({ kind: "failed", message: "Stream not ready — cannot pick." });
            return;
        }
        try {
            const slot = await channel.pickSlot(xNorm, yNorm);
            // Open the picker pre-populated with the picked slot.
            setPickerTarget({ slot });
            // Lazy-fetch library on first pick.
            if (library.kind === "unfetched") {
                void fetchLibrary();
            }
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            // UX policy on errors:
            //   - no_hit: silent (operator clicked empty space; no signal needed)
            //   - no_material: explanatory toast (it's an actionable case —
            //     "open in Composer to add a shader")
            //   - no_active_viewport: rare, but informative
            //   - everything else: surface the error code so we can debug
            if (ce.code === "no_hit") {
                // Silent — most "missed" clicks are expected operator behavior.
                return;
            }
            if (ce.code === "no_material") {
                showToast({
                    kind: "info",
                    message: "No material on this surface — open in Composer to add one.",
                });
                return;
            }
            showToast({ kind: "failed", message: `${ce.code}: ${ce.message}` });
        }
    }, [channel, assetId, library.kind, fetchLibrary, showToast]);

    // ---- click capture (toggle path) --------------------------------------

    const onOverlayClick = useCallback((evt: React.MouseEvent<HTMLDivElement>) => {
        // Only respond to the primary button.
        if (evt.button !== 0) return;
        evt.preventDefault();
        evt.stopPropagation();

        // Use the streaming wrapper's bounding rect for normalization;
        // fall back to the overlay's currentTarget rect if the host
        // didn't supply a wrapper ref. Touch and pen synthesize clicks
        // with clientX/clientY in modern browsers, and React maps them
        // through cleanly.
        const wrapper = streamWrapperRef?.current ?? evt.currentTarget;
        const rect = wrapper.getBoundingClientRect();
        const coords = computeNormalizedCoords(evt.clientX, evt.clientY, rect);
        if (coords === null) return;
        void performPick(coords.xNorm, coords.yNorm);
    }, [streamWrapperRef, performPick]);

    // ---- click capture (modifier-key path, document-level) -----------------

    useEffect(() => {
        if (!channel || !assetId) return;
        const handler = (evt: MouseEvent) => {
            // Only Cmd-click (Mac) or Ctrl-click (PC). Don't fire on
            // simple click — that would clobber orbit/pan.
            if (!(evt.metaKey || evt.ctrlKey)) return;
            // Only primary button.
            if (evt.button !== 0) return;
            // If the click was inside our overlay, the overlay's onClick
            // handler already fired performPick — don't double-fire.
            const target = evt.target as Element | null;
            if (target && target.closest('[data-testid="viewport-pick-overlay"]')) {
                return;
            }
            const wrapper = streamWrapperRef?.current;
            if (!wrapper) return;
            const rect = wrapper.getBoundingClientRect();
            // Make sure the click was within the streaming wrapper. This
            // prevents the document-level handler from firing when the
            // user Cmd-clicks something else on the page (toggle button,
            // toast, etc.).
            if (
                evt.clientX < rect.left || evt.clientX > rect.right ||
                evt.clientY < rect.top || evt.clientY > rect.bottom
            ) {
                return;
            }
            const coords = computeNormalizedCoords(evt.clientX, evt.clientY, rect);
            if (coords === null) return;
            evt.preventDefault();
            evt.stopPropagation();
            void performPick(coords.xNorm, coords.yNorm);
        };
        window.addEventListener("click", handler, true);
        return () => window.removeEventListener("click", handler, true);
    }, [channel, assetId, streamWrapperRef, performPick]);

    // ---- Esc to exit pick mode --------------------------------------------

    useEffect(() => {
        if (!pickModeOn) return;
        const handler = (evt: KeyboardEvent) => {
            if (evt.key === "Escape") {
                setPickModeOn(false);
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [pickModeOn]);

    // ---- pick → apply ------------------------------------------------------

    const recordRecentlyUsed = useCallback((pick: MdlPickerPick) => {
        setRecentlyUsed((prev) => {
            const without = prev.filter((p) => p.mdlPath !== pick.mdlPath);
            return [pick, ...without].slice(0, MAX_RECENTLY_USED);
        });
    }, []);

    const onPick = useCallback(async (pick: MdlPickerPick) => {
        if (!channel || !assetId || !pickerTarget) {
            setPickerTarget(null);
            return;
        }
        const target = pickerTarget;
        setPickerTarget(null);

        const targetLabel = target.slot.display_name || target.slot.source_name;
        showToast({ kind: "applying", mdlName: pick.displayName, targetLabel });

        try {
            await channel.setMaterialOverride(assetId, target.slot.slot_id, pick.mdlPath);
            showToast({ kind: "applied", mdlName: pick.displayName, targetLabel });
            recordRecentlyUsed(pick);
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            showToast({
                kind: "failed",
                message: `Apply failed: ${ce.code}: ${ce.message}`,
            });
        }
    }, [channel, assetId, pickerTarget, showToast, recordRecentlyUsed]);

    const closePicker = useCallback(() => setPickerTarget(null), []);

    // ---- derived render state ----------------------------------------------

    const channelReady = channel !== null && assetId !== null;
    const targetSlots = useMemo(() => {
        if (!pickerTarget) return [];
        // The slot from the pick result has all the fields MaterialSlot has,
        // plus prim_path_picked. The picker only reads MaterialSlot fields.
        // Strip prim_path_picked-style extras isn't required (it's an extra
        // property), but we conform via a destructure for clarity.
        const { prim_path_picked: _picked, ...slotAsMaterial } = pickerTarget.slot;
        return [slotAsMaterial];
    }, [pickerTarget]);

    const pickerCatalog = library.kind === "ok" ? library.catalog : null;
    const pickerLoadError = library.kind === "error" ? library.message : null;

    return (
        <>
            {/* Toggle button — top-right by default. CSS owns positioning. */}
            <div className="viewport-pick-toolbar" data-testid="viewport-pick-toolbar">
                <button
                    type="button"
                    className={pickModeOn ? "viewport-pick-toggle is-on" : "viewport-pick-toggle"}
                    data-testid="viewport-pick-toggle"
                    aria-pressed={pickModeOn}
                    disabled={!channelReady}
                    onClick={() => setPickModeOn((on) => !on)}
                    title={
                        channelReady
                            ? "Toggle pick mode (or hold Cmd/Ctrl and click)"
                            : "Stream not ready"
                    }
                >
                    {pickModeOn ? "Pick: ON" : "Pick"}
                </button>
            </div>

            {/* Click-capture overlay — shown only when pick mode is on. The
              * overlay covers the streaming canvas; pointerdown fires the
              * pick. CSS sets pointer-events: auto when the .is-on class is
              * present so non-pick mode lets clicks fall through to AppStream. */}
            {pickModeOn && channelReady && (
                <div
                    className="viewport-pick-overlay is-on"
                    data-testid="viewport-pick-overlay"
                    onClick={onOverlayClick}
                    role="button"
                    aria-label="Pick mode — tap a surface to pick its material slot"
                />
            )}

            {/* Picker modal. open when a tap returned a slot. */}
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
                <ViewportPickToast toast={toast} onDismiss={() => setToast({ kind: "hidden" })} />
            )}
        </>
    );
}

// ---- Toast subcomponent ----------------------------------------------------

function ViewportPickToast({
    toast,
    onDismiss,
}: {
    toast: Exclude<Toast, { kind: "hidden" }>;
    onDismiss: () => void;
}) {
    let testId = "viewport-pick-toast";
    let cssClass = "viewport-pick-toast";
    let body: React.ReactNode;

    switch (toast.kind) {
        case "info":
            testId = "viewport-pick-toast-info";
            body = <div className="viewport-pick-toast-message">{toast.message}</div>;
            break;
        case "applying":
            testId = "viewport-pick-toast-applying";
            body = (
                <>
                    <div className="viewport-pick-toast-title">
                        Applying <code>{toast.mdlName}</code>…
                    </div>
                    <div className="viewport-pick-toast-message">
                        Target: <code>{toast.targetLabel}</code>
                    </div>
                </>
            );
            break;
        case "applied":
            testId = "viewport-pick-toast-applied";
            cssClass += " viewport-pick-toast-ok";
            body = (
                <>
                    <div className="viewport-pick-toast-title">
                        Applied <code>{toast.mdlName}</code>
                    </div>
                    <div className="viewport-pick-toast-message">
                        to <code>{toast.targetLabel}</code>
                    </div>
                </>
            );
            break;
        case "failed":
            testId = "viewport-pick-toast-failed";
            cssClass += " viewport-pick-toast-error";
            body = <div className="viewport-pick-toast-message">{toast.message}</div>;
            break;
    }

    return (
        <div className={cssClass} data-testid={testId}>
            {body}
            <button
                type="button"
                className="viewport-pick-toast-dismiss"
                data-testid="viewport-pick-toast-dismiss"
                onClick={onDismiss}
                aria-label="Dismiss"
            >
                ×
            </button>
        </div>
    );
}
