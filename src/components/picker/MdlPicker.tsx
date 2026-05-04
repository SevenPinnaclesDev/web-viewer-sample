/*
 * MdlPicker — library-browser modal for the swatch primitive.
 *
 * When the Twin Architect clicks a slot in SwatchPanel, this modal opens
 * and lets them pick an MDL from the Nucleus-hosted library. Single click
 * applies to the target slot(s) and closes the modal. Esc dismisses
 * without applying. Search filters the grid live; the folder tree
 * navigates the catalog's category structure.
 *
 * Spec: clients/web/design/picker-ui-v1.md (Marcus's brief).
 *
 * Decisions overridden from the brief:
 *  - none of the 10 defaults flipped — I agree with all of them. The
 *    thumbnail rendering details are not in the 10; I'm defaulting to
 *    placeholder swatches because (a) Nucleus thumbnails can't be loaded
 *    directly from SPA without a thumbnail-proxy endpoint, and (b) the
 *    seed library is empty at this commit — Elena's authoring is in
 *    parallel. When thumbnails ship, the picker can be extended with a
 *    `thumbnailResolver` prop that maps catalog `thumbnail` field +
 *    category `path` to a fetchable URL (post-v1).
 *
 * State management: in-component for now per the brief. The catalog is
 * fetched once on first picker-open via `inputChannel.listLibraryMaterials()`,
 * cached in the picker's caller (SwatchPanel) for the session.
 *
 * Ryan Takeda — Phase 1 picker sprint, 2026-05-02.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
    LibraryCatalog,
    LibraryCategory,
    LibraryMaterialEntry,
    MaterialSlot,
} from "../../services/inputChannelTypes";
import "./MdlPicker.css";

/**
 * The shape of a "picked" MDL — what the picker hands to the caller's
 * onPick callback. `mdlPath` is the Nucleus URL the SPA passes to
 * `material.set_override`. `displayName` is what the toast shows.
 */
export interface MdlPickerPick {
    /** Fully-qualified omniverse:// URL to the MDL file on Nucleus. */
    mdlPath: string;
    /** Human-readable name from the catalog (toast + recently-used). */
    displayName: string;
    /** The material entry as the catalog knows it — for callers that want
     * to display tags / author / etc. */
    entry: LibraryMaterialEntry;
    /** The category this material belongs to — for path display. */
    category: LibraryCategory;
}

export interface MdlPickerProps {
    /** True when the modal should be visible. SwatchPanel toggles this. */
    open: boolean;

    /** The slot(s) the user is picking for. One slot in single mode,
     * multiple in bulk mode. The picker shows different headers per case
     * but the apply-flow is the same. Empty array is invalid (caller
     * shouldn't open the picker with nothing selected); we render a
     * "nothing selected" state defensively. */
    targetSlots: MaterialSlot[];

    /** The library catalog to browse. Caller fetches this lazily on first
     * open via inputChannel.listLibraryMaterials() and caches for the
     * session. While loading the caller passes null and we render a
     * loading state. On error, caller passes the error message via
     * `loadError`. */
    catalog: LibraryCatalog | null;

    /** Set when fetching the catalog failed; picker shows an error state
     * with a retry button. The caller wires the retry to its fetch. */
    loadError?: string | null;

    /** Caller-driven retry hook used by the error-state retry button. */
    onRetryFetch?: () => void;

    /** Called when the user clicks an MDL. Caller fires
     * material.set_override (single) or set_overrides_bulk (multi) and
     * shows a toast on success.
     *
     * The picker closes itself synchronously after invoking — no need to
     * await; if the apply fails the caller surfaces it via toast. */
    onPick: (pick: MdlPickerPick) => void;

    /** Called when the user dismisses without picking (Esc, click outside,
     * X button). Caller toggles `open` to false. */
    onDismiss: () => void;

    /** Picker-internal: caller passes the recently-used list (last 8 in
     * session, most-recent-first). The picker doesn't own this state
     * because multiple callers may share one library — keep it in
     * SwatchPanel. */
    recentlyUsed?: MdlPickerPick[];

    /** Optional Nucleus-hosted library root URL — used to compose full
     * mdl_path values from the catalog's category path + filename.
     * Defaults to the env-default-host /DATE/Library/Materials/. The
     * caller (SwatchPanel) typically passes whatever its environment
     * uses, but the default is correct for MFO-DATE. */
    libraryRootUrl?: string;
}

const DEFAULT_LIBRARY_ROOT_URL =
    "omniverse://nucleus.dasb256.tailcb8137.ts.net/DATE/Library/Materials";

const MAX_RECENTLY_USED = 8;

function fuzzyIncludes(haystack: string, needle: string): boolean {
    // Cheap fuzzy: every char of needle appears in haystack in order.
    // Empty needle always matches. Case-insensitive.
    if (!needle) return true;
    const h = haystack.toLowerCase();
    const n = needle.toLowerCase();
    let i = 0;
    for (const c of h) {
        if (c === n[i]) i++;
        if (i >= n.length) return true;
    }
    // Substring fallback handles the common "exact substring" case where
    // fuzzy ordering isn't quite right but the substring is right there.
    return h.includes(n);
}

function materialMatchesSearch(m: LibraryMaterialEntry, query: string): boolean {
    if (!query) return true;
    if (fuzzyIncludes(m.filename, query)) return true;
    if (fuzzyIncludes(m.display_name, query)) return true;
    for (const t of m.tags) {
        if (fuzzyIncludes(t, query)) return true;
    }
    return false;
}

function composeMdlPath(libraryRoot: string, category: LibraryCategory, m: LibraryMaterialEntry): string {
    const root = libraryRoot.replace(/\/$/, "");
    const categoryPath = category.path.replace(/^\//, "").replace(/\/$/, "");
    return `${root}/${categoryPath}/${m.filename}`;
}

/** Renders a placeholder swatch for thumbnails that aren't available.
 * Two-character mnemonic from the display name, on a derived background
 * color so two materials with the same first chars don't look identical. */
function placeholderColorFor(displayName: string): string {
    let hash = 0;
    for (let i = 0; i < displayName.length; i++) {
        hash = (hash * 31 + displayName.charCodeAt(i)) >>> 0;
    }
    // Pleasant low-saturation palette across the hue wheel.
    const h = hash % 360;
    return `hsl(${h}deg, 35%, 45%)`;
}

function placeholderInitials(displayName: string): string {
    const tokens = displayName.split(/[\s_]+/).filter(Boolean);
    if (tokens.length === 0) return "?";
    if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
    return (tokens[0][0] + tokens[1][0]).toUpperCase();
}

export function MdlPicker({
    open,
    targetSlots,
    catalog,
    loadError,
    onRetryFetch,
    onPick,
    onDismiss,
    recentlyUsed = [],
    libraryRootUrl = DEFAULT_LIBRARY_ROOT_URL,
}: MdlPickerProps) {
    const [search, setSearch] = useState("");
    const [activeCategoryPath, setActiveCategoryPath] = useState<string | null>(null);
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);

    // Reset internal state when the modal opens fresh, so the search box
    // and active category don't carry across opens.
    useEffect(() => {
        if (open) {
            setSearch("");
            setActiveCategoryPath(null);
            // Focus the search box so the user can start typing immediately.
            // setTimeout 0 to let the modal mount first.
            const t = setTimeout(() => {
                searchInputRef.current?.focus();
            }, 0);
            return () => clearTimeout(t);
        }
        return undefined;
    }, [open]);

    // Esc dismisses. Use a window-level keydown so focus inside the search
    // box still bubbles. Stop propagation so a parent shortcut handler
    // doesn't also fire (e.g. the lazy-susan key handler down the line).
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                onDismiss();
            }
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [open, onDismiss]);

    const onOverlayClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        // Click-outside dismiss — only when the click hit the overlay
        // itself, not a child.
        if (e.target === overlayRef.current) {
            onDismiss();
        }
    }, [onDismiss]);

    // Filter the categories per the active-category and search predicates.
    const filteredCategories = useMemo<LibraryCategory[]>(() => {
        if (!catalog) return [];
        const out: LibraryCategory[] = [];
        for (const cat of catalog.categories) {
            // Category-tree filter: when activeCategoryPath is set, only
            // include the matching category. Search alone always shows all.
            if (activeCategoryPath !== null && cat.path !== activeCategoryPath) continue;
            const materials = search
                ? cat.materials.filter((m) => materialMatchesSearch(m, search))
                : cat.materials;
            if (materials.length === 0 && search) continue; // hide empty categories during search
            out.push({ ...cat, materials });
        }
        return out;
    }, [catalog, search, activeCategoryPath]);

    const onMaterialClick = useCallback((cat: LibraryCategory, m: LibraryMaterialEntry) => {
        const pick: MdlPickerPick = {
            mdlPath: composeMdlPath(libraryRootUrl, cat, m),
            displayName: m.display_name,
            entry: m,
            category: cat,
        };
        onPick(pick);
    }, [libraryRootUrl, onPick]);

    if (!open) return null;

    // ---- header copy --------------------------------------------------

    let headerText: React.ReactNode;
    if (targetSlots.length === 0) {
        headerText = "Pick a material (no slot selected)";
    } else if (targetSlots.length === 1) {
        const slot = targetSlots[0];
        headerText = (
            <>
                Pick a material for <code>{slot.display_name || slot.source_name}</code>{" "}
                ({slot.bound_prim_count} prim{slot.bound_prim_count === 1 ? "" : "s"})
            </>
        );
    } else {
        headerText = (
            <>
                Pick material for <strong>{targetSlots.length}</strong> selected slots
            </>
        );
    }

    // ---- body decision: loading / error / catalog ----------------------

    let body: React.ReactNode;
    if (loadError) {
        body = (
            <div className="mdl-picker-error" data-testid="mdl-picker-error">
                <div className="mdl-picker-error-title">Couldn't load library</div>
                <div className="mdl-picker-error-message">{loadError}</div>
                {onRetryFetch && (
                    <button onClick={onRetryFetch} data-testid="mdl-picker-retry">
                        Retry
                    </button>
                )}
            </div>
        );
    } else if (!catalog) {
        body = (
            <div className="mdl-picker-loading" data-testid="mdl-picker-loading">
                Loading material library…
            </div>
        );
    } else if (catalog.categories.length === 0) {
        body = (
            <div className="mdl-picker-empty" data-testid="mdl-picker-empty">
                <div className="mdl-picker-empty-title">No materials in the library yet</div>
                <div className="mdl-picker-empty-message">
                    The Twin Architect needs to seed the library before this picker
                    is useful. See <code>tools/library-curator/README.md</code>.
                </div>
            </div>
        );
    } else {
        body = (
            <div className="mdl-picker-body">
                <div className="mdl-picker-tree" data-testid="mdl-picker-tree">
                    <button
                        className={`mdl-picker-tree-item ${activeCategoryPath === null ? "active" : ""}`}
                        data-testid="mdl-picker-tree-all"
                        onClick={() => setActiveCategoryPath(null)}
                    >
                        All ({totalMaterialCount(catalog)})
                    </button>
                    {catalog.categories.map((cat) => (
                        <button
                            key={cat.path}
                            className={`mdl-picker-tree-item ${activeCategoryPath === cat.path ? "active" : ""}`}
                            data-testid={`mdl-picker-tree-${cat.path}`}
                            onClick={() => setActiveCategoryPath(cat.path)}
                        >
                            {cat.display_name} ({cat.materials.length})
                        </button>
                    ))}
                </div>

                <div className="mdl-picker-grid-container" data-testid="mdl-picker-grid-container">
                    {recentlyUsed.length > 0 && !search && activeCategoryPath === null && (
                        <div className="mdl-picker-section" data-testid="mdl-picker-recent-section">
                            <div className="mdl-picker-section-header">Recently used</div>
                            <div className="mdl-picker-grid">
                                {recentlyUsed.slice(0, MAX_RECENTLY_USED).map((p) => (
                                    <button
                                        key={p.mdlPath}
                                        className="mdl-picker-card"
                                        data-testid="mdl-picker-recent-card"
                                        onClick={() => onPick(p)}
                                    >
                                        <div
                                            className="mdl-picker-thumbnail mdl-picker-thumbnail-placeholder"
                                            style={{ background: placeholderColorFor(p.displayName) }}
                                            aria-hidden
                                        >
                                            {placeholderInitials(p.displayName)}
                                        </div>
                                        <div className="mdl-picker-card-name">{p.displayName}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}

                    {filteredCategories.map((cat) => (
                        <div key={cat.path} className="mdl-picker-section">
                            <div className="mdl-picker-section-header">
                                {cat.display_name} ({cat.materials.length})
                            </div>
                            <div className="mdl-picker-grid" data-testid={`mdl-picker-grid-${cat.path}`}>
                                {cat.materials.map((m) => (
                                    <button
                                        key={m.filename}
                                        className="mdl-picker-card"
                                        data-testid="mdl-picker-card"
                                        data-mdl-filename={m.filename}
                                        onClick={() => onMaterialClick(cat, m)}
                                        title={m.tags.length ? `tags: ${m.tags.join(", ")}` : m.display_name}
                                    >
                                        <div
                                            className="mdl-picker-thumbnail mdl-picker-thumbnail-placeholder"
                                            style={{ background: placeholderColorFor(m.display_name) }}
                                            aria-hidden
                                        >
                                            {placeholderInitials(m.display_name)}
                                        </div>
                                        <div className="mdl-picker-card-name">{m.display_name}</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}

                    {search && filteredCategories.length === 0 && (
                        <div className="mdl-picker-empty-search" data-testid="mdl-picker-empty-search">
                            No materials match <code>{search}</code>.
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div
            ref={overlayRef}
            className="mdl-picker-overlay"
            data-testid="mdl-picker-overlay"
            onClick={onOverlayClick}
            role="dialog"
            aria-modal="true"
            aria-label="Material picker"
        >
            <div className="mdl-picker-modal" data-testid="mdl-picker-modal">
                <div className="mdl-picker-header">
                    <div
                        className="mdl-picker-header-text"
                        data-testid={
                            targetSlots.length > 1
                                ? "mdl-picker-header-bulk"
                                : "mdl-picker-header-single"
                        }
                    >
                        {headerText}
                    </div>
                    <button
                        className="mdl-picker-close"
                        data-testid="mdl-picker-close"
                        onClick={onDismiss}
                        aria-label="Close picker"
                    >
                        ×
                    </button>
                </div>

                <div className="mdl-picker-search-row">
                    <input
                        ref={searchInputRef}
                        type="text"
                        className="mdl-picker-search"
                        data-testid="mdl-picker-search"
                        placeholder="Search materials by name or tag…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                    />
                </div>

                {body}
            </div>
        </div>
    );
}

function totalMaterialCount(catalog: LibraryCatalog): number {
    let n = 0;
    for (const c of catalog.categories) n += c.materials.length;
    return n;
}
