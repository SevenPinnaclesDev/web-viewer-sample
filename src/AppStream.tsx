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
import React, { Component } from 'react';
import PropTypes from 'prop-types';
import { AppStreamer, StreamEvent, StreamProps, DirectConfig, GFNConfig, StreamType } from '@nvidia/omniverse-webrtc-streaming-library';
import StreamConfig from '../stream.config.json';


interface AppStreamProps {
    sessionId: string
    backendUrl: string
    signalingserver: string
    signalingport: number
    mediaserver: string
    mediaport: number
    accessToken: string
    style?: React.CSSProperties;
    onStarted: () => void;
    onStreamFailed: () => void;
    onLoggedIn: (userId: string) => void;
    handleCustomEvent: (event: any) => void;
    onFocus: () => void;
    onBlur: () => void;
}

interface AppStreamState {
    streamReady: boolean;
}

export default class AppStream extends Component<AppStreamProps, AppStreamState> {
    private _requested: boolean;

    static defaultProps = {
        style: {}
    };

    static propTypes = {
        onStarted: PropTypes.func.isRequired,
        handleCustomEvent: PropTypes.func.isRequired,
        style: PropTypes.object
    };

    constructor(props: AppStreamProps) {
        super(props);

        this._requested = false;
        this.state = {
            streamReady: false
        };
    }

    componentDidMount() {
        if (!this._requested) {
            this._requested = true;

            let streamProps: StreamProps;
            let streamConfig: DirectConfig | GFNConfig;
            let streamSource: StreamType.DIRECT | StreamType.GFN;

            if (StreamConfig.source === 'gfn') {
                    streamSource = StreamType.GFN;
                    streamConfig = {
                        //@ts-ignore
                        GFN             : GFN,
                        catalogClientId : StreamConfig.gfn.catalogClientId,
                        clientId        : StreamConfig.gfn.clientId,
                        cmsId           : StreamConfig.gfn.cmsId,
                        onUpdate        : (message: StreamEvent) => this._onUpdate(message),
                        onStart         : (message: StreamEvent) => this._onStart(message),
                        onCustomEvent   : (message: any) => this._onCustomEvent(message)
                    }
            }

            else if (StreamConfig.source === 'local') {
                streamSource = StreamType.DIRECT;
                // Phase-0.5 escape hatch: ?stream_port=<n> in the page URL overrides
                // StreamConfig.local.signalingPort. Lets us A/B between the Composer
                // streaming target (49100, default) and the new DATE Viewer kit-app
                // streaming target (49102) without rebuilding stream.config.json.
                // Drop the override in any non-numeric case (silent fallback to config).
                const _streamPortParam = new URLSearchParams(window.location.search).get('stream_port');
                const _streamPortOverride = _streamPortParam && /^\d+$/.test(_streamPortParam)
                    ? Number(_streamPortParam)
                    : null;
                const _signalingPort = _streamPortOverride ?? StreamConfig.local.signalingPort;
                if (_streamPortOverride !== null) {
                    console.info(`[DATE] stream_port query-param override: signalingPort=${_signalingPort} (config default was ${StreamConfig.local.signalingPort})`);
                }

                streamConfig = {
                    videoElementId: 'remote-video',
                    audioElementId: 'remote-audio',
                    // DATE Phase 0: substrate fronted by Caddy with Tailscale-issued Let's Encrypt
                    // cert at wss://dasb256.tailcb8137.ts.net:49100 → kit ws://127.0.0.1:49099.
                    // Phase 0.5 (2026-05-03): a parallel DATE Viewer kit-app streams on :49102 → :49098;
                    // selectable via ?stream_port=49102 query param (computed above).
                    // authenticate:true → appLevelProtocol=5 (wss); matches our TLS-terminated substrate.
                    authenticate: true,
                    maxReconnects: 20,
                    signalingServer: StreamConfig.local.server,
                    signalingPort: _signalingPort,
                    mediaServer: StreamConfig.local.server,
                    ...(StreamConfig.local.mediaPort != null && { mediaPort: StreamConfig.local.mediaPort }),
                    nativeTouchEvents: true,
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    onUpdate: (message: StreamEvent) => this._onUpdate(message),
                    onStart: (message: StreamEvent) => this._onStart(message),
                    onCustomEvent: (message: any) => this._onCustomEvent(message),
                    onStop: (message: StreamEvent) => { console.log(message) },
                    onTerminate: (message: StreamEvent) => { console.log(message) }
                };
            }
                
            else if (StreamConfig.source === 'stream') {
                streamSource =  StreamType.DIRECT;
                streamConfig = {
                    signalingServer: this.props.signalingserver,
                    signalingPort: this.props.signalingport,
                    mediaServer: this.props.mediaserver,
                    mediaPort: this.props.mediaport,
                    backendUrl: this.props.backendUrl,
                    sessionId: this.props.sessionId,
                    autoLaunch: true,
                    cursor: 'free',
                    mic: false,
                    videoElementId: 'remote-video',
                    audioElementId: 'remote-audio',
                    authenticate: true,
                    maxReconnects: 20,
                    nativeTouchEvents: true,
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    onUpdate: (message: StreamEvent) => this._onUpdate(message),
                    onStart: (message: StreamEvent) => this._onStart(message),
                    onCustomEvent: (message: any) => this._onCustomEvent(message),
                    onStop: (message: StreamEvent) => { console.log(message) },
                    onTerminate: (message: StreamEvent) => { console.log(message) },
                };
            }
                
            else {
                console.error(`Unknown stream source: ${StreamConfig.source}`);
                return
            }

            try {
                streamProps = {streamConfig, streamSource}
                AppStreamer.connect(streamProps)
                .then((result: StreamEvent) => {
                    console.info(result);
                })
                .catch((error: StreamEvent) => {
                    console.error(error);
                });
            }
            catch (error) {
                console.error(error);
            }
        }
    }

    componentDidUpdate(_prevProps: AppStreamProps, prevState: AppStreamState, _snapshot: any) {
        if (prevState.streamReady === false && this.state.streamReady === true) {
            const player = document.getElementById("gfn-stream-player-video") as HTMLVideoElement;
            if (player) {
                player.tabIndex = -1;
                player.playsInline = true;
                player.muted = true;
                player.play();
            }
        }
    }

    static sendMessage(message: any) {
        AppStreamer.sendMessage(message);
    }

    static stop() {
        AppStreamer.stop();
        (AppStreamer as any)._stream = null; // Accessing a private member
    }

    _onStart(message: any) {
        if (message.action === 'start' && message.status === 'success' && !this.state.streamReady) {
            console.info('streamReady');
            this.setState({ streamReady: true });
            this.props.onStarted();
        }

        if (message.status === "error" && StreamConfig.source === "stream")
        {
            console.log(message.info);
            alert(message.info);
            this.props.onStreamFailed();
            return;
        }
    }

    _onUpdate(message: any) {
        try {
            if (message.action === 'authUser' && message.status === 'success') {
                this.props.onLoggedIn(message.info);
            }
        } catch (error) {
            console.error(message);
        }
    }

    _onCustomEvent(message: any) {
        this.props.handleCustomEvent(message);
    }

    _onStop(message: any) {
        console.info('Stream stopped', message);
    }

    _onTerminate(message: any) {
        console.info('Stream terminated', message);
    }

    render() {
        const source = StreamConfig.source;

        if (source === 'gfn') {
            return (
                <div
                    id="view"
                    style={{
                        backgroundColor: this.state.streamReady ? 'white': '#dddddd',
                        display: 'flex', justifyContent: 'space-between',
                        height: "100%",
                        width: "100%",
                        ...this.props.style
                    }}
                />
            );
        } else if (source === 'local' || source === 'stream') {
            return (
                <div
                    key={'stream-canvas'}
                    id={'main-div'}
                    style={{
                        backgroundColor:this.state.streamReady ? 'white': '#dddddd',
                        visibility: this.state.streamReady ? 'visible' : 'hidden',
                        ...this.props.style
                    }}
                >
                    <video
                        key={'video-canvas'}
                        id={'remote-video'}
                        style={{
                            left: 0,
                            top: 0,
                            width: '100%',
                            height: '100%',
                        }}
                        tabIndex={-1}
                        playsInline muted
                        autoPlay
                    />
                    <audio id="remote-audio" muted></audio>
                    <h3 style={{ visibility: 'hidden' }} id="message-display">...</h3>
                </div>
            );
        }

        return null;
    }
}
