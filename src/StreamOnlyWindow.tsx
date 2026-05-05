/*
 * SPDX-FileCopyrightText: Copyright (c) 2024 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: LicenseRef-NvidiaProprietary
 *
 * NVIDIA CORPORATION, its affiliates and licensors retain all intellectual
 * property and proprietary rights in and to this material, related
 * documentation and any modifications thereto. Any use, reproduction,
 * disclosure or distribution of this material and related documentation
 * without an express license agreement from NVIDIA CORPORATION or
 * its affiliates is strictly prohibited.
 */
import React from 'react';
import AppStream from './AppStream';
import { AppProps } from './Window';
import { headerHeight } from './App';
import { DropZone } from './components/dragdrop/DropZone';
import { AssetBrowser } from './components/assetbrowser/AssetBrowser';
import { ViewportPickHandler } from './components/viewport-pick/ViewportPickHandler';
import { InputChannel } from './services/inputChannel';
import { runAuthGate } from './services/authGate';
import type { User } from './services/whoami';

interface StreamOnlyState {
    /** Becomes true when AppStream's `onStarted` fires (WebRTC pipe is up).
     * Gates the input_channel_v1 channel passed to DropZone — no point
     * sending kit messages before the data channel is ready. */
    showStream: boolean;

    /** Currently-open asset slug per the kit's `asset.opened` event.
     * ViewportPickHandler needs this to apply overrides on tap-to-pick;
     * `null` until the kit announces an asset (DropZone or AssetBrowser
     * triggers an open, kit fires asset.opened, we cache the slug). */
    currentAssetId: string | null;

    /** Auth state populated by `runAuthGate` on mount. While `pending`
     * we render a loading splash; on `redirected` we render a minimal
     * "Redirecting…" placeholder (the browser is already navigating);
     * on `error` we render an error state with retry; on `ready` we
     * render the streaming UI. */
    auth:
        | { kind: "pending" }
        | { kind: "ready"; user: User }
        | { kind: "redirected" }
        | { kind: "error"; message: string };
}

/**
 * StreamOnlyWindow — minimal SPA wrapper for streaming arbitrary kit apps
 * (Composer, custom apps, anything that's NOT the USD Viewer template).
 *
 * Originally a thin AppStream-only host with no SPA controls. As of
 * 2026-05-03 it carries the DATE customer-zero ingest path:
 *
 *   - InputChannel instance + DropZone overlay
 *   - showStream gates the channel, lit when WebRTC is up (rather than
 *     waiting on the USD Viewer template's openedStageResult event,
 *     which arbitrary kits won't send)
 *   - handleCustomEvent forwards input_channel_v1 response frames
 *     (asset.open ack, etc.) to InputChannel.handleFrame
 *
 * Same-origin refactor (2026-05-04): the entry point now gates on
 * `/auth/whoami` before rendering. 401 triggers a full-page redirect
 * to `/auth/login?return_to=<here>` per architecture/identity.md.
 *
 * The Window.tsx variant (USD Viewer template path) carries the same
 * DropZone wiring inside its `showUI` block — the two paths intentionally
 * duplicate the channel wiring rather than share, because the surrounding
 * UI semantics differ enough that a shared abstraction would leak.
 */
export default class StreamOnly extends React.Component<AppProps, StreamOnlyState> {

    private _inputChannel = new InputChannel(
        (jsonText: string) => (AppStream as any).sendMessage(jsonText),
        { defaultTimeoutMs: 8_000 },
    );

    /** Ref to the streaming wrapper so ViewportPickHandler can measure
     * its bounding rect for click→[0..1] normalization. */
    private _streamWrapperRef = React.createRef<HTMLDivElement>();

    /** Unsubscribe handle for the asset.opened subscription. */
    private _assetOpenedUnsubscribe: (() => void) | null = null;

    /** AbortController for the in-flight whoami request — cancelled on
     * unmount so a stale resolution doesn't try to setState. */
    private _authAbortController: AbortController | null = null;

    constructor(props: AppProps) {
        super(props);
        this.state = {
            showStream: false,
            currentAssetId: null,
            auth: { kind: "pending" },
        };
    }

    componentDidMount(): void {
        // Subscribe to asset.opened so we can update currentAssetId for
        // ViewportPickHandler. The kit fires this whenever a new asset
        // finishes loading (Composer's StageEventType.OPENED).
        this._assetOpenedUnsubscribe = this._inputChannel.onEvent(
            "asset.opened",
            (evt) => {
                const slug = (evt.payload as { asset_id?: string })?.asset_id;
                if (typeof slug === "string" && slug.length > 0) {
                    this.setState({ currentAssetId: slug });
                }
            },
        );

        void this._runAuthCheck();
    }

    componentWillUnmount(): void {
        if (this._assetOpenedUnsubscribe) {
            this._assetOpenedUnsubscribe();
            this._assetOpenedUnsubscribe = null;
        }
        if (this._authAbortController) {
            this._authAbortController.abort();
            this._authAbortController = null;
        }
    }

    /**
     * Run the SPA login flow. On 401 the helper kicks off a full-page
     * navigation; on success we stash the User in state and render the
     * rest of the SPA; on transient failure we render an error state
     * with a retry that re-invokes this method.
     */
    private async _runAuthCheck(): Promise<void> {
        this._authAbortController?.abort();
        const ctl = new AbortController();
        this._authAbortController = ctl;
        this.setState({ auth: { kind: "pending" } });
        const outcome = await runAuthGate({ signal: ctl.signal });
        if (ctl.signal.aborted) return;
        if (outcome.kind === "ok") {
            this.setState({ auth: { kind: "ready", user: outcome.user } });
        } else if (outcome.kind === "redirected") {
            this.setState({ auth: { kind: "redirected" } });
        } else {
            this.setState({ auth: { kind: "error", message: outcome.message } });
        }
    }

    /**
    * @function _onStreamStarted
    *
    * Fires when AppStream's WebRTC pipe is up. Light up the input channel
    * so DropZone's URL handler can fire `asset.open` from the daemon's
    * `?asset=…&nucleus_url=…` hand-off. We do NOT wait for any kit-side
    * custom event because StreamOnlyWindow is the path explicitly chosen
    * for kit apps that don't speak the USD Viewer template's protocol.
    */
    private _onStreamStarted (): void {
        console.log("The streaming session has started!");
        this.setState({ showStream: true });
    }

    /**
    * @function _handleCustomEvent
    *
    * Handle messages from the streamed kit app. Input_channel_v1 contract
    * responses (id+ok shape) are consumed by InputChannel.handleFrame
    * which resolves pending request promises. Anything else is logged
    * for diagnostic visibility.
    */
    private _handleCustomEvent (event: any): void {
        if (this._inputChannel.handleFrame(event)) {
            return;
        }
        console.log(event);
    }

    private _handleAppStreamFocus (): void {
        console.log('User is interacting in streamed viewer');
    }

    private _handleAppStreamBlur (): void {
        console.log('User is not interacting in streamed viewer');
    }

    render() {
        if (this.state.auth.kind === "pending") {
            return (
                <div className="loading-indicator-label" style={{ marginTop: headerHeight + 40 }}>
                    Checking session…
                </div>
            );
        }
        if (this.state.auth.kind === "redirected") {
            return (
                <div className="loading-indicator-label" style={{ marginTop: headerHeight + 40 }}>
                    Redirecting to sign in…
                </div>
            );
        }
        if (this.state.auth.kind === "error") {
            return (
                <div className="loading-indicator-label" style={{ marginTop: headerHeight + 40 }}>
                    <div>Couldn't verify session.</div>
                    <div style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>{this.state.auth.message}</div>
                    <button
                        className="nvidia-button"
                        style={{ marginTop: 12 }}
                        onClick={() => { void this._runAuthCheck(); }}
                    >
                        Retry
                    </button>
                </div>
            );
        }

        return (
            <div
                style={{
                    position: 'absolute',
                    top: headerHeight,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: 0,
                    margin: 0
                }}
            >
                <div id="streamonly-wrapper" ref={this._streamWrapperRef}>
                    <AppStream
                        sessionId={this.props.sessionId}
                        backendUrl={this.props.backendUrl}
                        signalingserver={this.props.signalingserver}
                        signalingport={this.props.signalingport}
                        mediaserver={this.props.mediaserver}
                        mediaport={this.props.mediaport}
                        accessToken={this.props.accessToken}
                        onStarted={() => this._onStreamStarted()}
                        onFocus={() => this._handleAppStreamFocus()}
                        onBlur={() => this._handleAppStreamBlur()}
                        style={{
                            width: '100%',
                            height: '100%',
                            padding: 0,
                            margin: 0
                        }}
                        onLoggedIn={(userId) => console.log(`User logged in: ${userId}`)}
                        handleCustomEvent={(event) => this._handleCustomEvent(event)}
                        onStreamFailed={this.props.onStreamFailed}
                    />
                </div>

                {/* DATE customer-zero DropZone — full-screen drag overlay +
                  * URL-handler that fires `asset.open` when the daemon hands
                  * off `?asset=…&nucleus_url=…` after a successful drop.
                  * Channel is gated on showStream so it only sends after
                  * WebRTC is up. */}
                <DropZone
                    channel={this.state.showStream ? this._inputChannel : null}
                />

                {/* Asset Browser — collapsible left-sidebar Finder over the
                  * Nucleus library. Default-collapsed so the streaming view
                  * is full-width by default; expand to pick + load any
                  * previously-ingested asset without re-dropping. */}
                <AssetBrowser
                    channel={this.state.showStream ? this._inputChannel : null}
                />

                {/* Tap-to-pick — captures clicks on the streamed viewport,
                  * resolves the prim under the tap to a material slot, and
                  * opens the picker pre-populated. This is Jim's customer-
                  * zero centerpiece (CoffeeWithJim 2026-05-03): "tap a
                  * wall, pick a material, the wall changes color live."
                  * Pick mode is a TOGGLE button (touch-friendly, since the
                  * customer-zero target is iPad streamed). Cmd/Ctrl-click
                  * works in addition for mouse-driven sessions. */}
                <ViewportPickHandler
                    channel={this.state.showStream ? this._inputChannel : null}
                    assetId={this.state.currentAssetId}
                    streamWrapperRef={this._streamWrapperRef}
                />
            </div>
        );
    }
}
