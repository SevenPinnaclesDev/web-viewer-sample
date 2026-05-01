/*
 * InputChannel service tests — exercise request/response correlation,
 * timeout, error envelopes, and event subscription against a mock
 * transport. No DOM, no AppStream, just the channel contract.
 *
 * Ryan Takeda — Phase 1 Day 1, 2026-05-01.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InputChannel, ChannelError } from "../inputChannel";

describe("InputChannel", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("serializes request with id/command/payload per contract §4.1", async () => {
        const sentJson: string[] = [];
        const ch = new InputChannel((j) => sentJson.push(j));

        // Don't await — we just want to inspect what was sent.
        ch.queryMaterialSlots("compass_step").catch(() => {});
        expect(sentJson.length).toBe(1);
        const frame = JSON.parse(sentJson[0]);
        expect(frame).toMatchObject({
            command: "material.query_slots",
            payload: { asset_id: "compass_step" },
        });
        expect(typeof frame.id).toBe("string");
        expect(frame.id.length).toBeGreaterThan(0);
    });

    it("resolves the request promise on a matching ok response", async () => {
        const sentJson: string[] = [];
        const ch = new InputChannel((j) => sentJson.push(j));
        const p = ch.queryMaterialSlots("x");

        const reqId = JSON.parse(sentJson[0]).id;
        ch.handleFrame({
            id: reqId,
            ok: true,
            result: { asset_id: "x", slots: [] },
        });

        await expect(p).resolves.toEqual({ asset_id: "x", slots: [] });
    });

    it("rejects the request promise on a matching error response", async () => {
        const sentJson: string[] = [];
        const ch = new InputChannel((j) => sentJson.push(j));
        const p = ch.queryMaterialSlots("x");

        const reqId = JSON.parse(sentJson[0]).id;
        ch.handleFrame({
            id: reqId,
            ok: false,
            error: { code: "asset_not_open", message: "no asset" },
        });

        await expect(p).rejects.toBeInstanceOf(ChannelError);
        await p.catch((e: ChannelError) => {
            expect(e.code).toBe("asset_not_open");
            expect(e.message).toBe("no asset");
        });
    });

    it("times out after defaultTimeoutMs with code spa_timeout", async () => {
        const ch = new InputChannel(() => {}, { defaultTimeoutMs: 500 });
        const p = ch.queryMaterialSlots("x");
        vi.advanceTimersByTime(600);
        await expect(p).rejects.toMatchObject({ code: "spa_timeout" });
    });

    it("ignores responses for unknown ids (late / duplicate)", () => {
        const ch = new InputChannel(() => {});
        const handled = ch.handleFrame({ id: "nobody-waiting", ok: true, result: {} });
        expect(handled).toBe(true); // it's a contract response, just dropped silently
    });

    it("does NOT consume legacy event_type frames (returns false)", () => {
        const ch = new InputChannel(() => {});
        expect(ch.handleFrame({ event_type: "openedStageResult", payload: {} })).toBe(false);
        expect(ch.handleFrame({ random: "garbage" })).toBe(false);
        expect(ch.handleFrame(null)).toBe(false);
    });

    it("dispatches §4.3 event frames to subscribers", () => {
        const ch = new InputChannel(() => {});
        const handler = vi.fn();
        const unsubscribe = ch.onEvent("asset.opened", handler);
        ch.handleFrame({ event: "asset.opened", payload: { asset_id: "compass_step" } });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][0]).toEqual({
            event: "asset.opened",
            payload: { asset_id: "compass_step" },
        });
        unsubscribe();
        ch.handleFrame({ event: "asset.opened", payload: {} });
        expect(handler).toHaveBeenCalledTimes(1); // unsubscribe stuck
    });

    it("cancelAll rejects every pending with spa_cancelled", async () => {
        const ch = new InputChannel(() => {});
        const a = ch.queryMaterialSlots("x");
        const b = ch.queryMaterialSlots("y");
        ch.cancelAll("disconnect");
        await expect(a).rejects.toMatchObject({ code: "spa_cancelled" });
        await expect(b).rejects.toMatchObject({ code: "spa_cancelled" });
        expect(ch.inflightCount).toBe(0);
    });

    it("typed wrapper for set_overrides_bulk forwards the slot_ids list", () => {
        const sentJson: string[] = [];
        const ch = new InputChannel((j) => sentJson.push(j));
        ch.setMaterialOverridesBulk("x", ["a", "b", "c"], "omniverse://nucleus/foo.mdl").catch(() => {});
        const frame = JSON.parse(sentJson[0]);
        expect(frame.command).toBe("material.set_overrides_bulk");
        expect(frame.payload).toEqual({
            asset_id: "x",
            slot_ids: ["a", "b", "c"],
            mdl_path: "omniverse://nucleus/foo.mdl",
        });
    });
});
