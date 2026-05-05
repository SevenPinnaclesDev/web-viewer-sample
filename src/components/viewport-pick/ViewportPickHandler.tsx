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

/** Floating action menu state. Appears anchored near the click point on
 * a successful pick. The operator chooses Hide / Isolate / Pick Material /
 * Focus from there.
 *
 * Anchor decision (2026-05-02 follow-up): we anchor to the click point
 * because Jim's customer-zero target is a CAD-style inspection workflow
 * ("I tap a wall, action menu pops up right there"). Fixed-corner would
 * disconnect the action from the spatial context. We clamp the menu so
 * it never overflows the viewport — see `clampMenuPosition`.
 */
type ActionMenuTarget = {
    slot: PickSlotResult;
    /** Page-coords of the original click — used to position the menu. */
    anchorX: number;
    anchorY: number;
};

type Toast =
    | { kind: "hidden" }
    | { kind: "info"; message: string }
    | { kind: "applying"; mdlName: string; targetLabel: string }
    | { kind: "applied"; mdlName: string; targetLabel: string }
    | { kind: "failed"; message: string };

const TOAST_DURATION_MS = 2400;
const MAX_RECENTLY_USED = 8;

/** Estimated menu dimensions used for clamping. Real measurement happens
 * via getBoundingClientRect after layout if we ever need pixel-perfect.
 * The estimate is sufficient because we only need to keep the menu inside
 * the viewport — being a few px short of an edge is fine.
 */
const ACTION_MENU_WIDTH = 168;
const ACTION_MENU_HEIGHT = 184;
const ACTION_MENU_OFFSET = 8; // gap between click point and menu edge

/**
 * Clamp a desired (x, y) position so the action menu fits inside the
 * viewport. Returns the top-left coords for the menu element.
 *
 * Anchoring strategy: place the menu's TOP-LEFT just below-and-right of
 * the click. If that would overflow the right edge, flip to the LEFT side
 * of the click. Same for vertical.
 */
export function clampMenuPosition(
    anchorX: number,
    anchorY: number,
    viewportWidth: number,
    viewportHeight: number,
    menuWidth: number = ACTION_MENU_WIDTH,
    menuHeight: number = ACTION_MENU_HEIGHT,
): { left: number; top: number } {
    let left = anchorX + ACTION_MENU_OFFSET;
    let top = anchorY + ACTION_MENU_OFFSET;
    // Flip horizontally if it would overflow the right edge.
    if (left + menuWidth > viewportWidth) {
        left = anchorX - menuWidth - ACTION_MENU_OFFSET;
    }
    // Flip vertically if it would overflow the bottom edge.
    if (top + menuHeight > viewportHeight) {
        top = anchorY - menuHeight - ACTION_MENU_OFFSET;
    }
    // Hard-clamp to viewport bounds.
    left = Math.max(4, Math.min(left, viewportWidth - menuWidth - 4));
    top = Math.max(4, Math.min(top, viewportHeight - menuHeight - 4));
    return { left, top };
}

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
    const [actionMenuTarget, setActionMenuTarget] = useState<ActionMenuTarget | null>(null);
    /** Set of prim paths that the operator has hidden via the action menu.
     * Pure session state — resets when assetId changes (fresh asset) or
     * when Show All is invoked. Persistence to a USD layer is v1.5
     * (Diana's territory). */
    const [hiddenPaths, setHiddenPaths] = useState<Set<string>>(new Set());
    const [library, setLibrary] = useState<LibraryState>({ kind: "unfetched" });
    const [recentlyUsed, setRecentlyUsed] = useState<MdlPickerPick[]>([]);
    const [toast, setToast] = useState<Toast>({ kind: "hidden" });

    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Reset hidden-set on asset switch — a fresh asset has no hidden state
    // (kit re-loads visibility from the freshly-opened stage). Keeping the
    // old asset's hidden-set around would lie to the user.
    useEffect(() => {
        setHiddenPaths(new Set());
        // Also dismiss any open action menu on asset switch.
        setActionMenuTarget(null);
    }, [assetId]);

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

    const performPick = useCallback(async (
        xNorm: number,
        yNorm: number,
        anchorX: number,
        anchorY: number,
    ) => {
        if (!channel || !assetId) {
            showToast({ kind: "failed", message: "Stream not ready — cannot pick." });
            return;
        }
        try {
            const slot = await channel.pickSlot(xNorm, yNorm);
            // Open the floating action menu pre-populated with the picked
            // slot. The user picks Hide / Isolate / Pick Material / Focus
            // from there; "Pick Material" is what opens the MdlPicker modal.
            setActionMenuTarget({ slot, anchorX, anchorY });
            // Pre-fetch the library so the picker is fast if the user
            // chooses Pick Material — we hide the latency in the action
            // menu's brief lifetime.
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
        void performPick(coords.xNorm, coords.yNorm, evt.clientX, evt.clientY);
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
            void performPick(coords.xNorm, coords.yNorm, evt.clientX, evt.clientY);
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

    // ---- action menu handlers (Hide / Isolate / Pick Material / Focus) ----

    /** Dismiss the action menu without acting. Bound to Esc + outside clicks. */
    const dismissActionMenu = useCallback(() => setActionMenuTarget(null), []);

    /** Hide the prim under the picked target. Adds the path to hiddenPaths
     * so the indicator updates and the operator can see "12 things hidden."
     * On error: surface a failed toast; do NOT add to hiddenPaths. */
    const handleActionHide = useCallback(async () => {
        if (!channel || !actionMenuTarget) return;
        const path = actionMenuTarget.slot.prim_path_picked;
        const targetLabel = actionMenuTarget.slot.display_name || actionMenuTarget.slot.source_name;
        setActionMenuTarget(null);
        try {
            await channel.hidePrims([path]);
            setHiddenPaths((prev) => {
                const next = new Set(prev);
                next.add(path);
                return next;
            });
            showToast({ kind: "info", message: `Hid ${targetLabel}` });
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            showToast({ kind: "failed", message: `Hide failed: ${ce.code}: ${ce.message}` });
        }
    }, [channel, actionMenuTarget, showToast]);

    /** Isolate the prim — kit hides everything else. We track the picked
     * path in hiddenPaths INVERSELY: nothing here belongs in the hidden
     * set because the SPA's "hidden things" indicator is meant for "stuff
     * you hid," not "stuff that's invisible because you isolated something
     * else." Show All clears all of it back regardless. */
    const handleActionIsolate = useCallback(async () => {
        if (!channel || !actionMenuTarget) return;
        const path = actionMenuTarget.slot.prim_path_picked;
        const targetLabel = actionMenuTarget.slot.display_name || actionMenuTarget.slot.source_name;
        setActionMenuTarget(null);
        try {
            await channel.isolatePrims([path]);
            // Mark "isolation active" via a synthetic key so the indicator
            // shows "isolating <X>". We re-use hiddenPaths since the
            // streaming-viewport state is "X is the only thing visible";
            // the indicator below counts hiddenPaths.size which is fine
            // for either UI. Cleaner still: a separate `isolation` state.
            // For v1 we keep one indicator: "isolation: <name>" toast +
            // we leave hiddenPaths empty (isolation isn't a hide-list).
            showToast({ kind: "info", message: `Isolated ${targetLabel}` });
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            showToast({ kind: "failed", message: `Isolate failed: ${ce.code}: ${ce.message}` });
        }
    }, [channel, actionMenuTarget, showToast]);

    /** "Pick Material" — opens the existing picker modal pre-populated. */
    const handleActionPickMaterial = useCallback(() => {
        if (!actionMenuTarget) return;
        setPickerTarget({ slot: actionMenuTarget.slot });
        setActionMenuTarget(null);
    }, [actionMenuTarget]);

    /** "Focus" — placeholder. Wires up when the parallel agent's
     * view.focus_at_point command lands. Until then the button is
     * rendered but disabled. */
    const handleActionFocus = useCallback(() => {
        // Intentionally inert at v1 — the kit-side view.focus_at_point
        // command isn't implemented yet (parallel agent's lane). When
        // landed: call channel.focusAtPoint(prim_path_picked).
        showToast({
            kind: "info",
            message: "Focus comes online with the next view-extension drop.",
        });
        setActionMenuTarget(null);
    }, [showToast]);

    /** Show All — toolbar button. Always available. Resets hiddenPaths. */
    const handleShowAll = useCallback(async () => {
        if (!channel) return;
        try {
            await channel.showAll();
            setHiddenPaths(new Set());
            showToast({ kind: "info", message: "Showing all" });
        } catch (err) {
            const ce = err instanceof ChannelError
                ? err
                : new ChannelError("kit_internal", err instanceof Error ? err.message : String(err));
            showToast({ kind: "failed", message: `Show All failed: ${ce.code}: ${ce.message}` });
        }
    }, [channel, showToast]);

    // Esc closes the action menu (matches the existing Esc-closes-pick-mode
    // pattern). Outside-click handled by an invisible backdrop in JSX.
    useEffect(() => {
        if (!actionMenuTarget) return;
        const handler = (evt: KeyboardEvent) => {
            if (evt.key === "Escape") dismissActionMenu();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [actionMenuTarget, dismissActionMenu]);

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
            {/* Toolbar — Pick toggle + Show All button. CSS owns positioning. */}
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
                <button
                    type="button"
                    className="viewport-pick-show-all"
                    data-testid="viewport-pick-show-all"
                    disabled={!channel}
                    onClick={handleShowAll}
                    title="Restore visibility on all hidden / isolated prims"
                >
                    Show All{hiddenPaths.size > 0 ? ` (${hiddenPaths.size})` : ""}
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

            {/* Floating action menu — appears anchored to the click point on
              * a successful pick. Hide / Isolate / Pick Material / Focus.
              * Outside click dismisses via the invisible backdrop. */}
            {actionMenuTarget && (
                <ActionMenu
                    target={actionMenuTarget}
                    onHide={handleActionHide}
                    onIsolate={handleActionIsolate}
                    onPickMaterial={handleActionPickMaterial}
                    onFocus={handleActionFocus}
                    onDismiss={dismissActionMenu}
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

// ---- ActionMenu subcomponent ----------------------------------------------

/**
 * Floating menu rendered near the click point after a successful pick.
 * Buttons trigger Hide / Isolate / Pick Material / Focus actions; an
 * invisible backdrop dismisses on outside-click without consuming the
 * follow-up click on a button.
 *
 * Position math lives in clampMenuPosition (exported for unit tests).
 */
function ActionMenu({
    target,
    onHide,
    onIsolate,
    onPickMaterial,
    onFocus,
    onDismiss,
}: {
    target: ActionMenuTarget;
    onHide: () => void;
    onIsolate: () => void;
    onPickMaterial: () => void;
    onFocus: () => void;
    onDismiss: () => void;
}) {
    const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1920;
    const viewportHeight = typeof window !== "undefined" ? window.innerHeight : 1080;
    const { left, top } = clampMenuPosition(
        target.anchorX, target.anchorY,
        viewportWidth, viewportHeight,
    );
    const targetLabel = target.slot.display_name || target.slot.source_name;
    return (
        <>
            {/* Backdrop — full-screen, invisible, captures outside-clicks. */}
            <div
                className="viewport-pick-action-backdrop"
                data-testid="viewport-pick-action-backdrop"
                onClick={onDismiss}
                aria-hidden="true"
            />
            <div
                className="viewport-pick-action-menu"
                data-testid="viewport-pick-action-menu"
                style={{ left, top }}
                role="menu"
                aria-label={`Action menu for ${targetLabel}`}
            >
                <div className="viewport-pick-action-header">
                    <code>{targetLabel}</code>
                </div>
                <button
                    type="button"
                    className="viewport-pick-action-button"
                    data-testid="viewport-pick-action-hide"
                    onClick={onHide}
                    role="menuitem"
                >
                    Hide
                </button>
                <button
                    type="button"
                    className="viewport-pick-action-button"
                    data-testid="viewport-pick-action-isolate"
                    onClick={onIsolate}
                    role="menuitem"
                >
                    Isolate
                </button>
                <button
                    type="button"
                    className="viewport-pick-action-button"
                    data-testid="viewport-pick-action-pick-material"
                    onClick={onPickMaterial}
                    role="menuitem"
                >
                    Pick Material
                </button>
                <button
                    type="button"
                    className="viewport-pick-action-button viewport-pick-action-disabled"
                    data-testid="viewport-pick-action-focus"
                    onClick={onFocus}
                    role="menuitem"
                    title="Comes online with the next view-extension drop"
                >
                    Focus
                </button>
            </div>
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
