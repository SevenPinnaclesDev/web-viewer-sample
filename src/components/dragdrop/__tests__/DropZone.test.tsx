/*
 * DropZone component tests — drag-drop simulation through React Testing
 * Library + a stub fetch + a stub WebSocket.
 *
 * Coverage:
 *   - Overlay activates on dragenter with files
 *   - Overlay hides on dragleave
 *   - Drop with accepted extension POSTs to /ingest, opens WS, displays
 *     lifecycle frames, fires asset.open on completed
 *   - Drop with rejected extension shows the rejected toast and does NOT
 *     POST to ingest
 *   - POST /ingest non-2xx shows failed toast
 *   - WS failed frame shows failed toast
 *   - kit channel rejection (after completed) shows failed toast
 *
 * Ryan Takeda — Phase 1 close-the-loop, 2026-05-01.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { DropZone } from "../DropZone";
import type { WebSocketCtor } from "../../../services/ingestLifecycle";


// ---- Mock WebSocket -------------------------------------------------------

class MockWS {
    readonly url: string;
    onmessage: ((evt: MessageEvent) => void) | null = null;
    onclose: ((evt: CloseEvent) => void) | null = null;
    onerror: ((evt: Event) => void) | null = null;
    closed = false;

    constructor(url: string) {
        this.url = url;
        MockWS.instances.push(this);
    }

    static instances: MockWS[] = [];
    static reset() { MockWS.instances = []; }

    pushFrame(f: object): void {
        this.onmessage?.({ data: JSON.stringify(f) } as MessageEvent);
    }

    close(): void {
        this.closed = true;
    }
}


// ---- Mock InputChannel — only the methods DropZone reaches for -----------

function makeMockChannel(overrides: Partial<{
    openAsset: (assetId: string, version?: number, nucleusUrl?: string) => Promise<unknown>;
}> = {}) {
    const openAsset = overrides.openAsset ?? vi.fn().mockResolvedValue({
        asset_id: "compass_step",
        nucleus_url: "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
        open_request_acked: true,
        version: 3,
    });
    return { openAsset } as any;
}


// ---- Helpers --------------------------------------------------------------

function makeFile(name: string, content = "fake content"): File {
    return new File([content], name, { type: "application/octet-stream" });
}

/**
 * Simulate a drag event with files. jsdom doesn't construct DragEvents
 * with a meaningful dataTransfer; we hand-craft the event detail.
 */
function fireDragEvent(
    target: Element,
    type: "dragenter" | "dragover" | "dragleave" | "drop",
    files: File[],
): void {
    const dataTransfer: Partial<DataTransfer> = {
        files: filesAsList(files),
        types: files.length > 0 ? ["Files"] : [],
    };
    const evt = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(evt, "dataTransfer", { value: dataTransfer });
    fireEvent(target, evt);
}

function filesAsList(files: File[]): FileList {
    // Minimal FileList shim — index access + length + item().
    const list = {
        length: files.length,
        item: (i: number) => files[i] ?? null,
        [Symbol.iterator]: function* () { yield* files; },
    } as unknown as FileList;
    for (let i = 0; i < files.length; i++) {
        (list as unknown as { [n: number]: File })[i] = files[i];
    }
    return list;
}

function makePostResponse(body: object, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? "OK" : "Error",
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
    } as unknown as Response;
}


// ---- Tests ----------------------------------------------------------------

describe("DropZone", () => {
    beforeEach(() => {
        MockWS.reset();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("renders host, no overlay or toast initially", () => {
        const channel = makeMockChannel();
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={vi.fn() as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        expect(screen.getByTestId("dropzone-host")).toBeInTheDocument();
        expect(screen.queryByTestId("dropzone-overlay")).not.toBeInTheDocument();
        expect(screen.queryByTestId("dropzone-toast-uploading")).not.toBeInTheDocument();
    });

    it("activates overlay on dragenter with files; hides on dragleave", () => {
        const channel = makeMockChannel();
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={vi.fn() as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "dragenter", [makeFile("compass.usdz")]);
        expect(screen.getByTestId("dropzone-overlay")).toBeInTheDocument();
        fireDragEvent(host, "dragleave", [makeFile("compass.usdz")]);
        expect(screen.queryByTestId("dropzone-overlay")).not.toBeInTheDocument();
    });

    it("rejects unknown extension client-side; does not POST", () => {
        const fetchSpy = vi.fn();
        const channel = makeMockChannel();
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("bad.png")]);
        expect(screen.getByTestId("dropzone-toast-rejected")).toBeInTheDocument();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("rejects file with no extension client-side", () => {
        const fetchSpy = vi.fn();
        const channel = makeMockChannel();
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("noextension")]);
        expect(screen.getByTestId("dropzone-toast-rejected")).toBeInTheDocument();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("POSTs accepted file to /ingest, shows lifecycle frames, fires asset.open on completed", async () => {
        const channel = makeMockChannel();
        const fetchSpy = vi.fn().mockResolvedValue(makePostResponse({
            asset_id: "compass_step",
            ws_url: "wss://ingest.test/ingest/ws/job-1",
            expected_pipeline: "passthrough",
            files: [{
                file_index: 0, original_filename: "compass.usdz",
                bytes_written: 100, source_class: "usdz", pipeline: "passthrough",
                job_id: "job-1", asset_id: "compass_step",
                ws_url: "wss://ingest.test/ingest/ws/job-1",
            }],
        }));
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("compass.usdz")]);

        // POST kicks off async; uploading toast shows before response resolves
        await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
            "https://ingest.test/ingest",
            expect.objectContaining({ method: "POST" }),
        ));

        // After resolve, WS opens
        await waitFor(() => expect(MockWS.instances.length).toBe(1));
        const ws = MockWS.instances[0];
        expect(ws.url).toBe("wss://ingest.test/ingest/ws/job-1");

        // Push a lifecycle frame — UI updates
        await act(async () => {
            ws.pushFrame({
                state: "processing", stage: "convert.hoops",
                progress_pct: 45, message: "converting STEP",
                ts: "2026-05-01T19:00:00+00:00", context: {},
            });
        });
        expect(screen.getByTestId("dropzone-toast-lifecycle")).toBeInTheDocument();
        expect(screen.getByTestId("dropzone-toast-lifecycle")).toHaveTextContent(/processing/);
        expect(screen.getByTestId("dropzone-toast-lifecycle")).toHaveTextContent(/45%/);

        // Push completed frame — DropZone fires openAsset and shows loaded toast
        await act(async () => {
            ws.pushFrame({
                state: "completed", stage: "ingest.completed",
                progress_pct: 100, message: "asset published",
                ts: "2026-05-01T19:00:05+00:00",
                context: {
                    asset_slug: "compass_step",
                    nucleus_url: "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
                    version: "3",
                },
            });
        });

        await waitFor(() => expect(channel.openAsset).toHaveBeenCalledWith(
            "compass_step",
            3,
            "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
        ));
        await waitFor(() => expect(screen.getByTestId("dropzone-toast-loaded")).toBeInTheDocument());
        expect(screen.getByTestId("dropzone-toast-loaded")).toHaveTextContent(/compass_step/);
    });

    it("shows failed toast when POST /ingest returns non-2xx", async () => {
        const channel = makeMockChannel();
        const fetchSpy = vi.fn().mockResolvedValue(makePostResponse(
            { detail: "unsupported format" }, 415,
        ));
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("compass.stp")]);
        await waitFor(() => expect(screen.getByTestId("dropzone-toast-failed")).toBeInTheDocument());
    });

    it("shows failed toast on lifecycle failed frame", async () => {
        const channel = makeMockChannel();
        const fetchSpy = vi.fn().mockResolvedValue(makePostResponse({
            asset_id: "x", ws_url: "wss://test/ws/job-1",
        }));
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("compass.ifc")]);

        await waitFor(() => expect(MockWS.instances.length).toBe(1));
        const ws = MockWS.instances[0];

        await act(async () => {
            ws.pushFrame({
                state: "failed", stage: "convert.ifc",
                progress_pct: 100, message: "schema not supported",
                ts: "2026-05-01T19:00:00+00:00",
                context: { last_error: "schema_unsupported", reason: "IFC4x3" },
            });
        });

        await waitFor(() => expect(screen.getByTestId("dropzone-toast-failed")).toBeInTheDocument());
        expect(screen.getByTestId("dropzone-toast-failed")).toHaveTextContent(/schema_unsupported/);
        expect(channel.openAsset).not.toHaveBeenCalled();
    });

    it("shows failed toast when kit channel rejects asset.open after completed", async () => {
        const channel = makeMockChannel({
            openAsset: vi.fn().mockRejectedValue(new Error("nucleus_unreachable: timeout")),
        });
        const fetchSpy = vi.fn().mockResolvedValue(makePostResponse({
            asset_id: "x", ws_url: "wss://test/ws/job-1",
        }));
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("compass.stp")]);

        await waitFor(() => expect(MockWS.instances.length).toBe(1));
        const ws = MockWS.instances[0];

        await act(async () => {
            ws.pushFrame({
                state: "completed", stage: "ingest.completed",
                progress_pct: 100, message: "asset published",
                ts: "2026-05-01T19:00:00+00:00",
                context: {
                    asset_slug: "compass_step",
                    nucleus_url: "omniverse://nucleus/DATE/assets/compass_step/v3/scene.usd",
                    version: "3",
                },
            });
        });

        await waitFor(() => expect(screen.getByTestId("dropzone-toast-failed")).toBeInTheDocument());
        expect(screen.getByTestId("dropzone-toast-failed")).toHaveTextContent(/nucleus_unreachable/);
    });

    it("dismiss button closes the toast", async () => {
        const channel = makeMockChannel();
        const fetchSpy = vi.fn();
        render(
            <DropZone
                channel={channel}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("noextension")]);
        expect(screen.getByTestId("dropzone-toast-rejected")).toBeInTheDocument();
        fireEvent.click(screen.getByTestId("dropzone-toast-dismiss"));
        expect(screen.queryByTestId("dropzone-toast-rejected")).not.toBeInTheDocument();
    });

    it("with channel=null, completed frame still shows loaded toast (asset is in Nucleus)", async () => {
        const fetchSpy = vi.fn().mockResolvedValue(makePostResponse({
            asset_id: "x", ws_url: "wss://test/ws/job-1",
        }));
        render(
            <DropZone
                channel={null}
                ingestServiceUrl="https://ingest.test"
                fetchFn={fetchSpy as unknown as typeof fetch}
                WebSocketCtor={MockWS as unknown as WebSocketCtor}
            />,
        );
        const host = screen.getByTestId("dropzone-host");
        fireDragEvent(host, "drop", [makeFile("x.usdz")]);

        await waitFor(() => expect(MockWS.instances.length).toBe(1));
        const ws = MockWS.instances[0];

        await act(async () => {
            ws.pushFrame({
                state: "completed", stage: "ingest.completed",
                progress_pct: 100, message: "asset published",
                ts: "2026-05-01T19:00:00+00:00",
                context: {
                    asset_slug: "x",
                    nucleus_url: "omniverse://nucleus/DATE/assets/x/v1/scene.usd",
                },
            });
        });

        await waitFor(() => expect(screen.getByTestId("dropzone-toast-loaded")).toBeInTheDocument());
    });
});
