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
import { InputChannel } from './services/inputChannel';
import StreamConfig from '../stream.config.json';

interface StreamOnlyState {
    /** Becomes true when AppStream's `onStarted` fires (WebRTC pipe is up).
     * Gates the input_channel_v1 channel passed to DropZone — no point
     * sending kit messages before the data channel is ready. */
    showStream: boolean;
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

    constructor(props: AppProps) {
        super(props);
        this.state = {
            showStream: false,
        };
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

    /**
     * Resolve the DATE ingest service base URL. Mirrors Window.tsx's
     * `_ingestServiceUrl` — ingest runs at :49101 on the same host as the
     * streaming server (per Phase 1.5 D2-D5).
     */
    private _ingestServiceUrl(): string {
        const host = (StreamConfig as any).local?.server ?? "localhost";
        return `https://${host}:49101`;
    }

    private _handleAppStreamFocus (): void {
        console.log('User is interacting in streamed viewer');
    }

    private _handleAppStreamBlur (): void {
        console.log('User is not interacting in streamed viewer');
    }

    render() {
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
                <div id="streamonly-wrapper">
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
                    ingestServiceUrl={this._ingestServiceUrl()}
                />
            </div>
        );
    }
}
