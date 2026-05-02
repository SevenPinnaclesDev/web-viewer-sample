/*
 * IngestLifecycle service tests — drive a mock WebSocket through the
 * frame state machine + verify completion/failure/transport-error paths.
 *
 * Ryan Takeda — Phase 1 close-the-loop, 2026-05-01.
 */
import { describe, it, expect, vi } from "vitest";
import {
    subscribeToIngestLifecycle,
    isTerminalState,
    type IngestLifecycleFrame,
    type WebSocketCtor,
} from "../ingestLifecycle";


/**
 * Minimal mock WebSocket that lets the test drive onmessage / onclose
 * synchronously. Mirrors the spec where it matters (onmessage, onclose,
 * onerror, close()).
 */
class MockWS {
    readonly url: string;
    onmessage: ((evt: MessageEvent) => void) | null = null;
    onclose: ((evt: CloseEvent) => void) | null = null;
    onerror: ((evt: Event) => void) | null = null;
    closed = false;

    constructor(url: string) {
        this.url = url;
        // Track every constructed instance for tests that need to pull
        // the active socket out.
        MockWS.instances.push(this);
    }

    static instances: MockWS[] = [];
    static reset() { MockWS.instances = []; }

    /** Test helper: deliver a JSON frame to the subscriber. */
    pushFrame(frame: object): void {
        const evt = { data: JSON.stringify(frame) } as MessageEvent;
        this.onmessage?.(evt);
    }

    /** Test helper: deliver a raw string (e.g. malformed). */
    pushRaw(raw: string): void {
        this.onmessage?.({ data: raw } as MessageEvent);
    }

    /** Test helper: trigger a server-side close. */
    serverClose(code = 1006, reason = ""): void {
        this.onclose?.({ code, reason } as CloseEvent);
    }

    close(): void {
        this.closed = true;
    }
}


function frame(state: string, ctx: Record<string, string> = {}, extras: Partial<IngestLifecycleFrame> = {}): object {
    return {
        state,
        stage: extras.stage ?? `stage.${state}`,
        progress_pct: extras.progress_pct ?? 50,
        message: extras.message ?? `transitioned to ${state}`,
        ts: extras.ts ?? "2026-05-01T19:00:00+00:00",
        context: ctx,
    };
}


describe("subscribeToIngestLifecycle", () => {
    it("forwards every frame through onFrame in arrival order", () => {
        MockWS.reset();
        const seen: string[] = [];
        const sub = subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onFrame: (f) => seen.push(f.state) },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushFrame(frame("received"));
        ws.pushFrame(frame("routed", { pipeline: "hoops" }));
        ws.pushFrame(frame("queued"));
        expect(seen).toEqual(["received", "routed", "queued"]);
        expect(sub.active).toBe(true);
    });

    it("fires onCompleted with promoted asset_slug + nucleus_url + version on completed state", () => {
        MockWS.reset();
        const completedSpy = vi.fn();
        const sub = subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onCompleted: completedSpy },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushFrame(frame("completed", {
            asset_slug: "compass_step",
            nucleus_url: "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
            version: "3",
        }));
        expect(completedSpy).toHaveBeenCalledTimes(1);
        const info = completedSpy.mock.calls[0][0];
        expect(info.asset_slug).toBe("compass_step");
        expect(info.nucleus_url).toBe("omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd");
        expect(info.version).toBe(3);
        expect(info.raw_context.asset_slug).toBe("compass_step");
        expect(sub.active).toBe(false);
        expect(ws.closed).toBe(true);
    });

    it("fires onFailed with last_error + message on failed state", () => {
        MockWS.reset();
        const failedSpy = vi.fn();
        const sub = subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onFailed: failedSpy },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushFrame(frame("failed", {
            last_error: "convert_failed",
            reason: "IfcOpenShell crashed on schema 4x3",
        }));
        expect(failedSpy).toHaveBeenCalledTimes(1);
        const info = failedSpy.mock.calls[0][0];
        expect(info.last_error).toBe("convert_failed");
        expect(info.message).toBe("IfcOpenShell crashed on schema 4x3");
        expect(sub.active).toBe(false);
    });

    it("fires onTransportError when the WS closes before terminal frame", () => {
        MockWS.reset();
        const transportSpy = vi.fn();
        const completedSpy = vi.fn();
        subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onCompleted: completedSpy, onTransportError: transportSpy },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushFrame(frame("processing"));
        ws.serverClose(1006, "abnormal");
        expect(transportSpy).toHaveBeenCalledTimes(1);
        const err = transportSpy.mock.calls[0][0];
        expect(err.message).toContain("ingest WS closed before terminal frame");
        expect(completedSpy).not.toHaveBeenCalled();
    });

    it("does NOT fire onTransportError when close follows a terminal frame", () => {
        MockWS.reset();
        const transportSpy = vi.fn();
        const completedSpy = vi.fn();
        subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onCompleted: completedSpy, onTransportError: transportSpy },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushFrame(frame("completed", { asset_slug: "x", nucleus_url: "omniverse://nucleus/DATE/assets/x/v1/scene.usd" }));
        ws.serverClose(1000, "normal");
        expect(completedSpy).toHaveBeenCalledTimes(1);
        expect(transportSpy).not.toHaveBeenCalled();
    });

    it("close() halts subscription — subsequent frames are ignored", () => {
        MockWS.reset();
        const seen: string[] = [];
        const sub = subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onFrame: (f) => seen.push(f.state) },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushFrame(frame("received"));
        sub.close();
        ws.pushFrame(frame("routed"));
        expect(seen).toEqual(["received"]);
        expect(sub.active).toBe(false);
    });

    it("drops malformed JSON frames silently", () => {
        MockWS.reset();
        const seen: string[] = [];
        subscribeToIngestLifecycle(
            "wss://test/ingest/ws/job-1",
            { onFrame: (f) => seen.push(f.state) },
            { WebSocketCtor: MockWS as unknown as WebSocketCtor },
        );
        const ws = MockWS.instances[0];
        ws.pushRaw("not json {");
        ws.pushRaw("{}"); // missing state — drop
        ws.pushFrame(frame("received"));
        expect(seen).toEqual(["received"]);
    });

    it("synchronously surfaces transport error if WebSocket constructor throws", () => {
        const FailingCtor = function FailingCtor(_url: string): WebSocket {
            throw new Error("connection refused at construct time");
        } as unknown as WebSocketCtor;
        const transportSpy = vi.fn();
        const sub = subscribeToIngestLifecycle(
            "wss://nope/ingest/ws/job-1",
            { onTransportError: transportSpy },
            { WebSocketCtor: FailingCtor },
        );
        expect(transportSpy).toHaveBeenCalledTimes(1);
        expect(transportSpy.mock.calls[0][0].message).toContain("connection refused");
        expect(sub.active).toBe(false);
    });
});


describe("isTerminalState", () => {
    it("recognizes completed / failed / ready as terminal", () => {
        expect(isTerminalState("completed")).toBe(true);
        expect(isTerminalState("failed")).toBe(true);
        expect(isTerminalState("ready")).toBe(true);
    });

    it("recognizes intermediate states as non-terminal", () => {
        expect(isTerminalState("received")).toBe(false);
        expect(isTerminalState("processing")).toBe(false);
        expect(isTerminalState("normalizing")).toBe(false);
    });
});
