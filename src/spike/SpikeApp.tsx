/*
 * SpikeApp — slot-list spike harness, Ryan Takeda 2026-04-30
 *
 * Mounted only when ?spike=slots is in the URL (see main.tsx). Lets us
 * eyeball both Backspace (2-logical-slot, 6-physical-slot) and Compass
 * (~82 logical, 127 physical) STEP→Hoops outputs side-by-side or one at
 * a time, without disturbing the streaming sample app.
 *
 * No streaming, no Kit, no service. Just the slot list rendered against
 * the JSON we'd expect query_material_slots to produce in Phase 1.
 */
import { useState } from "react";
import type { SlotFixture } from "./types";
import { SlotList } from "./SlotList";
import "./SpikeApp.css";

import backspaceFixture from "../../fixtures/elena-2026-04-30/backspace_step.slots.json";
import compassFixture from "../../fixtures/elena-2026-04-30/compass_step.slots.json";

type ViewMode = "backspace" | "compass" | "side-by-side";

const FIXTURES: Record<"backspace" | "compass", SlotFixture> = {
    backspace: backspaceFixture as unknown as SlotFixture,
    compass: compassFixture as unknown as SlotFixture,
};

export function SpikeApp() {
    const [mode, setMode] = useState<ViewMode>("compass");

    return (
        <div className="spike-root">
            <header className="spike-header">
                <div className="spike-title">
                    <strong>DATE — slot-list spike</strong>
                    <span className="spike-subtitle">
                        Phase 1 paint-swatch UI · falsifiable list-render against Elena's 2026-04-30 STEP→Hoops outputs
                    </span>
                </div>
                <div className="spike-controls">
                    <button
                        className={mode === "backspace" ? "active" : ""}
                        onClick={() => setMode("backspace")}
                    >
                        Backspace ({FIXTURES.backspace.summary.slot_count})
                    </button>
                    <button
                        className={mode === "compass" ? "active" : ""}
                        onClick={() => setMode("compass")}
                    >
                        Compass ({FIXTURES.compass.summary.slot_count})
                    </button>
                    <button
                        className={mode === "side-by-side" ? "active" : ""}
                        onClick={() => setMode("side-by-side")}
                    >
                        Side-by-side
                    </button>
                </div>
            </header>

            <main className={`spike-main mode-${mode}`}>
                {mode === "backspace" && <SlotList fixture={FIXTURES.backspace} />}
                {mode === "compass" && <SlotList fixture={FIXTURES.compass} />}
                {mode === "side-by-side" && (
                    <>
                        <SlotList fixture={FIXTURES.backspace} />
                        <SlotList fixture={FIXTURES.compass} />
                    </>
                )}
            </main>

            <footer className="spike-footer">
                Spike harness only · returns to streaming app at{" "}
                <a href="./">./</a> (drop the <code>?spike=slots</code> query)
            </footer>
        </div>
    );
}
