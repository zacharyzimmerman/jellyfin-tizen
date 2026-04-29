(function () {
    'use strict';

    console.log('Tizen adapter');

    // Screensaver bypass overview:
    //
    // Samsung OLED TVs force a screensaver after 2 min of static pixels. The
    // firmware only suppresses it when the HARDWARE VIDEO DECODER is active.
    // Tizen also has a single media element limitation — only one <audio> or
    // <video> can play at a time.
    //
    // Solution: intercept document.createElement('audio') and add a src setter
    // hook to the returned <audio> element. When jellyfin-web sets an audio
    // URL, we swap the <audio> for a <video> in the DOM and route playback
    // through jMuxer's MSE pipeline. jMuxer combines AAC audio with pre-baked
    // H.264 black video frames in a single SourceBuffer, engaging the hardware
    // video decoder and suppressing the screensaver.
    //
    // IMPORTANT: createElement still returns a real <audio> element (not <video>)
    // so that jellyfin-web's device profile probing via canPlayType() works
    // correctly on Tizen. The swap to <video> only happens at playback time.

    // Pre-baked H.264 elementary stream: 128x128 black, constrained baseline, level 1.3, 1fps
    // Contains SPS + PPS + SEI + 5 IDR frames. We extract SPS+PPS+IDR for
    // repeating as keyframes alongside audio data.
    // Codec string: avc1.42c00d (Constrained Baseline, Level 1.3)
    var H264_BASE64 = 'AAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABBgX//1zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIzIDA0ODBjYjAgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTE6LTM6LTMgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTIuMDA6MC43MCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTQgdGhyZWFkcz00IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTEga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTUxLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjIwAIAAAAFliIQFc5yYoAAhIybk5OTk5OTrdddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABZYiCAIM5yYoAAk1ycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAFnQsAN3CBGwEQAAAMABAAAAwAIPFCuAAAAAWjOAZRMgAAAAWWIhAIM5yYoAAk1ycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAABZ0LADdwgRsBEAAADAAQAAAMACDxQrgAAAAFozgGUTIAAAAFliIIAgznJigACTXJycnJycnJ111111111111111111111111111111111111111111111111111111114AAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABZYiEAgznJigACTXJycnJycnJ111111111111111111111111111111111111111111111111111111114A==';

    // Run MSE codec diagnostics at startup (results visible in TV debug console)
    (function diagnoseMSE() {
        var codecs = [
            'video/mp4; codecs="avc1.42c00d"',
            'video/mp4; codecs="avc1.42c00d,mp4a.40.2"',
            'video/mp4; codecs="avc1.42E01E"',
            'video/mp4; codecs="avc1.42E01E,mp4a.40.2"',
            'video/mp4; codecs="avc1.4D401E"',
            'video/mp4; codecs="avc1.640028"',
            'audio/mp4; codecs="mp4a.40.2"',
            'video/mp4; codecs="mp4a.40.2"',
            'video/mp4',
            'audio/mp4'
        ];
        var hasMS = typeof MediaSource !== 'undefined';
        console.log('[TIZEN-DIAG] MediaSource available:', hasMS);
        if (hasMS) {
            codecs.forEach(function (c) {
                console.log('[TIZEN-DIAG] isTypeSupported(' + c + '):', MediaSource.isTypeSupported(c));
            });
        }
    })();

    function base64ToUint8Array(base64) {
        var binary = atob(base64);
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    // Parse H.264 annex-b NAL units and build a reusable keyframe (SPS+PPS+IDR)
    function buildKeyframe(data) {
        var nals = [];
        var i = 0;
        while (i < data.length - 4) {
            var startCodeLen = 0;
            if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1) {
                startCodeLen = 4;
            } else if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 1) {
                startCodeLen = 3;
            }
            if (startCodeLen > 0) {
                var end = data.length;
                for (var j = i + startCodeLen; j < data.length - 3; j++) {
                    if ((data[j] === 0 && data[j+1] === 0 && data[j+2] === 0 && data[j+3] === 1) ||
                        (data[j] === 0 && data[j+1] === 0 && data[j+2] === 1)) {
                        end = j;
                        break;
                    }
                }
                var nalType = data[i + startCodeLen] & 0x1F;
                nals.push({ type: nalType, data: data.slice(i, end) });
                i = end;
            } else {
                i++;
            }
        }
        var sps = nals.filter(function (n) { return n.type === 7; })[0];
        var pps = nals.filter(function (n) { return n.type === 8; })[0];
        var idr = nals.filter(function (n) { return n.type === 5; })[0];
        if (!sps || !pps || !idr) return null;
        var kf = new Uint8Array(sps.data.length + pps.data.length + idr.data.length);
        kf.set(sps.data, 0);
        kf.set(pps.data, sps.data.length);
        kf.set(idr.data, sps.data.length + pps.data.length);
        return kf;
    }

    // Extract complete ADTS frames from a buffer, returning any incomplete tail
    function extractADTSFrames(buffer) {
        var frames = [];
        var i = 0;
        while (i < buffer.length) {
            if (i + 6 >= buffer.length) break;
            if (buffer[i] !== 0xFF || (buffer[i + 1] & 0xF0) !== 0xF0) {
                var found = false;
                for (var j = i + 1; j < buffer.length - 1; j++) {
                    if (buffer[j] === 0xFF && (buffer[j + 1] & 0xF0) === 0xF0) {
                        i = j;
                        found = true;
                        break;
                    }
                }
                if (!found) break;
            }
            var frameLen = ((buffer[i + 3] & 0x03) << 11) |
                           (buffer[i + 4] << 3) |
                           ((buffer[i + 5] & 0xE0) >>> 5);
            if (frameLen < 7) { i++; continue; }
            if (i + frameLen > buffer.length) break;
            frames.push(buffer.slice(i, i + frameLen));
            i += frameLen;
        }
        var remainder = i < buffer.length ? buffer.slice(i) : new Uint8Array(0);
        return { frames: frames, remainder: remainder };
    }

    // Build the H.264 keyframe data once at startup
    var h264Data = base64ToUint8Array(H264_BASE64);
    var h264Keyframe = buildKeyframe(h264Data);

    function postMessage() {
        console.log.apply(console, arguments);
    }

    // Track active jMuxer instances for cleanup
    var activeJMuxer = null;
    var activeFetchController = null;

    // Track the native src descriptor once for reuse in fallback
    var nativeSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');

    // Start jMuxer MSE pipeline on a video element with audio from the given URL
    function startMSEPlayback(videoEl, audioSrcUrl) {
        // Clean up any previous instance
        stopMSEPlayback();

        if (!h264Keyframe) {
            postMessage('screensaverBypass', 'H.264 keyframe data missing — falling back to native');
            return false;
        }

        if (typeof JMuxer === 'undefined') {
            postMessage('screensaverBypass', 'JMuxer not loaded — falling back to native');
            return false;
        }

        // Check if MSE is available and supports our codecs
        if (typeof MediaSource === 'undefined') {
            postMessage('screensaverBypass', 'MediaSource not available — falling back to native');
            return false;
        }

        var mseType = 'video/mp4; codecs="avc1.42c00d,mp4a.40.2"';
        if (!MediaSource.isTypeSupported(mseType)) {
            postMessage('screensaverBypass', 'MSE type not supported: ' + mseType + ' — falling back to native');
            // Try video-only as a secondary check
            var videoOnly = 'video/mp4; codecs="avc1.42c00d"';
            postMessage('screensaverBypass', 'video-only support: ' + MediaSource.isTypeSupported(videoOnly));
            return false;
        }

        // Rewrite the audio URL to request AAC ADTS format for jMuxer
        var adtsUrl = rewriteToADTS(audioSrcUrl);
        if (!adtsUrl) {
            postMessage('screensaverBypass', 'Cannot rewrite URL to ADTS — falling back to native');
            return false;
        }

        postMessage('screensaverBypass', 'starting jMuxer MSE pipeline');
        postMessage('screensaverBypass', { originalUrl: audioSrcUrl, adtsUrl: adtsUrl });

        var abortController = new AbortController();
        activeFetchController = abortController;

        // Wrap jMuxer creation in try/catch for TV-specific failures
        var jmuxer;
        try {
            jmuxer = new JMuxer({
                node: videoEl,
                mode: 'both',
                fps: 1,
                flushingTime: 100,
                maxDelay: 2000,
                clearBuffer: true,
                debug: false,
                onReady: function () {
                    postMessage('screensaverBypass', 'MSE ready — feeding initial video');
                    try {
                        // Feed initial H.264 data to set up the video track
                        jmuxer.feed({ video: h264Data, duration: 1000 });
                        // Start streaming audio
                        streamAudio(jmuxer, adtsUrl, abortController);
                    } catch (feedErr) {
                        postMessage('screensaverBypass', { initFeedError: feedErr.message });
                        fallbackToNative(videoEl, audioSrcUrl);
                    }
                },
                onError: function (err) {
                    postMessage('screensaverBypass', { jmuxerError: err });
                    fallbackToNative(videoEl, audioSrcUrl);
                }
            });
        } catch (initErr) {
            postMessage('screensaverBypass', { jmuxerInitError: initErr.message });
            return false;
        }

        activeJMuxer = jmuxer;
        return true;
    }

    // Fall back to native audio playback if MSE fails on the TV
    function fallbackToNative(videoEl, originalUrl) {
        postMessage('screensaverBypass', 'MSE runtime error — falling back to native audio playback');
        stopMSEPlayback();

        // If we have the original <audio> element, swap it back in
        var audioEl = videoEl._originalAudioEl;
        if (audioEl && videoEl.parentNode) {
            postMessage('screensaverBypass', 'restoring original <audio> element');
            videoEl.parentNode.replaceChild(audioEl, videoEl);
            nativeSrcDesc.set.call(audioEl, originalUrl);
        } else if (nativeSrcDesc) {
            // Can't swap back — try playing on the video element directly
            nativeSrcDesc.set.call(videoEl, originalUrl);
        }
    }

    function stopMSEPlayback() {
        if (activeFetchController) {
            activeFetchController.abort();
            activeFetchController = null;
        }
        if (activeJMuxer) {
            try { activeJMuxer.destroy(); } catch (e) { /* ignore */ }
            activeJMuxer = null;
        }
    }

    function streamAudio(jmuxer, adtsUrl, abortController) {
        fetch(adtsUrl, { signal: abortController.signal })
            .then(function (response) {
                if (!response.ok) {
                    postMessage('screensaverBypass', { audioFetchError: 'HTTP ' + response.status });
                    return;
                }
                postMessage('screensaverBypass', 'audio stream started');

                var reader = response.body.getReader();
                var remainder = new Uint8Array(0);

                function readChunk() {
                    reader.read().then(function (result) {
                        if (result.done) {
                            postMessage('screensaverBypass', 'audio stream ended');
                            return;
                        }

                        // Concatenate with remainder from previous chunk
                        var combined = new Uint8Array(remainder.length + result.value.length);
                        combined.set(remainder, 0);
                        combined.set(result.value, remainder.length);

                        // Extract complete ADTS frames
                        var parsed = extractADTSFrames(combined);
                        remainder = parsed.remainder;

                        if (parsed.frames.length > 0) {
                            // Concatenate frames into one buffer
                            var totalBytes = 0;
                            for (var k = 0; k < parsed.frames.length; k++) totalBytes += parsed.frames[k].length;
                            var audioChunk = new Uint8Array(totalBytes);
                            var offset = 0;
                            for (var k = 0; k < parsed.frames.length; k++) {
                                audioChunk.set(parsed.frames[k], offset);
                                offset += parsed.frames[k].length;
                            }

                            // Feed audio + a video keyframe to keep the decoder engaged
                            try {
                                jmuxer.feed({
                                    video: h264Keyframe,
                                    audio: audioChunk,
                                    duration: Math.round((parsed.frames.length / 44) * 1000)
                                });
                            } catch (e) {
                                postMessage('screensaverBypass', { feedError: e.message });
                            }
                        }

                        readChunk();
                    }).catch(function (err) {
                        if (err.name !== 'AbortError') {
                            postMessage('screensaverBypass', { readError: err.message });
                        }
                    });
                }

                readChunk();
            })
            .catch(function (err) {
                if (err.name !== 'AbortError') {
                    postMessage('screensaverBypass', { fetchError: err.message });
                }
            });
    }

    // Rewrite a Jellyfin audio URL to request AAC in ADTS format
    function rewriteToADTS(url) {
        try {
            var u = new URL(url);

            // Handle /Audio/{id}/universal endpoint
            if (/\/Audio\/[^/]+\/universal/i.test(u.pathname)) {
                // Replace with the stream endpoint requesting ADTS
                u.pathname = u.pathname.replace('/universal', '/stream');
                u.searchParams.set('Container', 'adts');
                u.searchParams.set('AudioCodec', 'aac');
                // Remove HLS-specific params
                u.searchParams.delete('TranscodingProtocol');
                u.searchParams.delete('TranscodingContainer');
                return u.toString();
            }

            // Handle /Audio/{id}/stream endpoint
            if (/\/Audio\/[^/]+\/stream/i.test(u.pathname)) {
                u.searchParams.set('Container', 'adts');
                u.searchParams.set('AudioCodec', 'aac');
                return u.toString();
            }

            // Handle HLS .m3u8 URLs — can't easily rewrite these
            if (u.pathname.endsWith('.m3u8')) {
                return null;
            }

            return null;
        } catch (e) {
            return null;
        }
    }

    // Override document.createElement: hook <audio> src setter for late swap to <video>
    var _origCreateElement = document.createElement.bind(document);
    document.createElement = function (tagName) {
        if (tagName && tagName.toLowerCase() === 'audio') {
            // Return a REAL <audio> element — this preserves canPlayType() behavior
            // for jellyfin-web's device profile probing (browserDeviceProfile.js).
            var el = _origCreateElement('audio');
            el._tizenHooked = true;

            postMessage('screensaverBypass', 'hooking <audio> src setter');

            // Intercept the src setter. When an actual audio playback URL is set,
            // swap this <audio> for a <video> in the DOM and use jMuxer MSE.
            Object.defineProperty(el, 'src', {
                get: function () {
                    return nativeSrcDesc.get.call(el);
                },
                set: function (url) {
                    postMessage('screensaverBypass', { srcSet: url ? url.substring(0, 120) : url });

                    // Only intercept Jellyfin audio playback URLs
                    if (url && /\/Audio\//i.test(url)) {
                        postMessage('screensaverBypass', 'audio URL detected — attempting MSE swap');

                        // Create a <video> element to replace this <audio>
                        var videoEl = _origCreateElement('video');
                        videoEl.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
                        videoEl.setAttribute('playsinline', '');
                        videoEl._tizenAudioSwap = true;
                        videoEl._originalAudioEl = el;

                        // Copy over relevant attributes and classes
                        for (var i = 0; i < el.classList.length; i++) {
                            videoEl.classList.add(el.classList[i]);
                        }

                        // Try to start MSE pipeline on the video element
                        var started = startMSEPlayback(videoEl, url);
                        if (started) {
                            postMessage('screensaverBypass', 'MSE started — swapping <audio> for <video> in DOM');

                            // Replace <audio> in DOM if it's attached
                            if (el.parentNode) {
                                el.parentNode.replaceChild(videoEl, el);
                            }

                            // Patch jellyfin-web's reference: htmlAudioPlayer stores its
                            // element in _mediaElement and also queries '.mediaPlayerAudio'
                            videoEl._originalAudioSrc = url;

                            // Hook the video element's src setter too for subsequent URL changes
                            Object.defineProperty(videoEl, 'src', {
                                get: function () { return nativeSrcDesc.get.call(videoEl); },
                                set: function (vUrl) {
                                    postMessage('screensaverBypass', { videoSrcSet: vUrl ? vUrl.substring(0, 120) : vUrl });
                                    if (vUrl && /\/Audio\//i.test(vUrl)) {
                                        var restarted = startMSEPlayback(videoEl, vUrl);
                                        if (restarted) { videoEl._originalAudioSrc = vUrl; return; }
                                    }
                                    if (!vUrl || !vUrl.startsWith('blob:')) stopMSEPlayback();
                                    nativeSrcDesc.set.call(videoEl, vUrl);
                                },
                                configurable: true,
                                enumerable: true
                            });

                            return;
                        }

                        postMessage('screensaverBypass', 'MSE failed — using native <audio> playback');
                    }

                    // Default: set src on the <audio> element natively
                    nativeSrcDesc.set.call(el, url);
                },
                configurable: true,
                enumerable: true
            });

            return el;
        }
        return _origCreateElement.apply(document, arguments);
    };

    // Similar to jellyfin-web
    function generateDeviceId() {
        return btoa([navigator.userAgent, new Date().getTime()].join('|')).replace(/=/g, '1');
    }

    function getDeviceId() {
        // Use variable '_deviceId2' to mimic jellyfin-web
        var deviceId = localStorage.getItem('_deviceId2');

        if (!deviceId) {
            deviceId = generateDeviceId();
            localStorage.setItem('_deviceId2', deviceId);
        }

        return deviceId;
    }

    // Pre-fill server address on first launch so user doesn't have to type it
    (function preFillServer() {
        var SERVER_URL = 'https://movies.great-tags.com';
        var creds = localStorage.getItem('jellyfin_credentials');
        if (!creds) {
            var id = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, function () {
                return (Math.random() * 16 | 0).toString(16);
            });
            localStorage.setItem('jellyfin_credentials', JSON.stringify({
                Servers: [{
                    Id: id,
                    ManualAddress: SERVER_URL,
                    LastConnectionMode: 2,
                    manualAddressOnly: true,
                    DateLastAccessed: Date.now()
                }]
            }));
            postMessage('serverPreFill', 'pre-filled server: ' + SERVER_URL);
        }
    })();

    var AppInfo = {
        deviceId: getDeviceId(),
        deviceName: 'Samsung Smart TV',
        appName: 'Jellyfin for Tizen',
        appVersion: tizen.application.getCurrentApplication().appInfo.version
    };

    // List of supported features
    var SupportedFeatures = [
        'exit',
        'exitmenu',
        'externallinkdisplay',
        'htmlaudioautoplay',
        'htmlvideoautoplay',
        'physicalvolumecontrol',
        'displaylanguage',
        'otherapppromotions',
        'targetblank',
        'screensaver',
        'multiserver',
        'subtitleappearancesettings',
        'subtitleburnsettings'
    ];

    var systeminfo;

    function getSystemInfo() {
        if (systeminfo) {
            return Promise.resolve(systeminfo);
        }

        return new Promise(function (resolve) {
            tizen.systeminfo.getPropertyValue('DISPLAY', function (result) {
                var devicePixelRatio = 1;

                if (typeof webapis.productinfo.is8KPanelSupported === 'function' && webapis.productinfo.is8KPanelSupported()){
                    console.log("8K UHD is supported");
                    devicePixelRatio = 4;
                } else if (typeof webapis.productinfo.isUdPanelSupported === 'function' && webapis.productinfo.isUdPanelSupported()){
                    console.log("4K UHD is supported");
                    devicePixelRatio = 2;
                } else {
                    console.log("UHD is not supported");
                }

                systeminfo = Object.assign({}, result, {
                    resolutionWidth: Math.floor(result.resolutionWidth * devicePixelRatio),
                    resolutionHeight: Math.floor(result.resolutionHeight * devicePixelRatio)
                });

                resolve(systeminfo)
            });
        });
    }

    window.NativeShell = {
        AppHost: {
            init: function () {
                postMessage('AppHost.init', AppInfo);
                return getSystemInfo().then(function () {
                    return Promise.resolve(AppInfo);
                });
            },

            appName: function () {
                postMessage('AppHost.appName', AppInfo.appName);
                return AppInfo.appName;
            },

            appVersion: function () {
                postMessage('AppHost.appVersion', AppInfo.appVersion);
                return AppInfo.appVersion;
            },

            deviceId: function () {
                postMessage('AppHost.deviceId', AppInfo.deviceId);
                return AppInfo.deviceId;
            },

            deviceName: function () {
                postMessage('AppHost.deviceName', AppInfo.deviceName);
                return AppInfo.deviceName;
            },

            exit: function () {
                postMessage('AppHost.exit');
                stopMSEPlayback();

                try {
                    webapis.appcommon.setScreenSaver(
                        webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
                    );
                } catch (e) { /* ignore */ }
                try {
                    tizen.power.release('SCREEN');
                } catch (e) { /* ignore */ }

                tizen.application.getCurrentApplication().exit();
            },

            getDefaultLayout: function () {
                postMessage('AppHost.getDefaultLayout', 'tv');
                return 'tv';
            },

            getDeviceProfile: function (profileBuilder) {
                postMessage('AppHost.getDeviceProfile');
                return profileBuilder({ enableMkvProgressive: false, enableSsaRender: true });
            },

            getSyncProfile: function (profileBuilder) {
                postMessage('AppHost.getSyncProfile');
                return profileBuilder({ enableMkvProgressive: false });
            },

            screen: function () {
                return systeminfo ? {
                    width: systeminfo.resolutionWidth,
                    height: systeminfo.resolutionHeight
                } : null;
            },

            supports: function (command) {
                var isSupported = command && SupportedFeatures.indexOf(command.toLowerCase()) != -1;
                postMessage('AppHost.supports', {
                    command: command,
                    isSupported: isSupported
                });
                return isSupported;
            }
        },

        downloadFile: function (url) {
            postMessage('downloadFile', { url: url });
        },

        enableFullscreen: function () {
            postMessage('enableFullscreen');
        },

        disableFullscreen: function () {
            postMessage('disableFullscreen');
        },

        getPlugins: function () {
            postMessage('getPlugins');
            return [];
        },

        openUrl: function (url, target) {
            postMessage('openUrl', {
                url: url,
                target: target
            });
        },

        updateMediaSession: function (mediaInfo) {
            postMessage('updateMediaSession', { mediaInfo: mediaInfo });

            try {
                webapis.appcommon.setScreenSaver(
                    webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                    function (result) {
                        postMessage('setScreenSaver', { state: 'OFF', result: result });
                    },
                    function (error) {
                        postMessage('setScreenSaver', { state: 'OFF', error: JSON.stringify(error) });
                    }
                );
            } catch (e) {
                postMessage('setScreenSaver', { error: e.message });
            }
        },

        hideMediaSession: function () {
            postMessage('hideMediaSession');

            try {
                webapis.appcommon.setScreenSaver(
                    webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON,
                    function (result) {
                        postMessage('setScreenSaver', { state: 'ON', result: result });
                    },
                    function (error) {
                        postMessage('setScreenSaver', { state: 'ON', error: JSON.stringify(error) });
                    }
                );
            } catch (e) {
                postMessage('setScreenSaver', { error: e.message });
            }
        }
    };

    // Belt-and-suspenders: also use Power API during media playback
    function suppressScreenSaver() {
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                function () { postMessage('setScreenSaver', { state: 'OFF' }); },
                function (err) { postMessage('setScreenSaver', { state: 'OFF', error: JSON.stringify(err) }); }
            );
        } catch (e) { /* ignore */ }

        try {
            tizen.power.request('SCREEN', 'SCREEN_NORMAL');
        } catch (e) { /* ignore */ }
    }

    function restoreScreenSaver() {
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON,
                function () { postMessage('setScreenSaver', { state: 'ON' }); },
                function (err) { postMessage('setScreenSaver', { state: 'ON', error: JSON.stringify(err) }); }
            );
        } catch (e) { /* ignore */ }

        try {
            tizen.power.release('SCREEN');
        } catch (e) { /* ignore */ }
    }

    function attachMediaListeners(el) {
        if (el._tizenListenersAttached) return;
        el._tizenListenersAttached = true;
        el.addEventListener('playing', suppressScreenSaver);
        el.addEventListener('pause', restoreScreenSaver);
        el.addEventListener('ended', restoreScreenSaver);
        el.addEventListener('emptied', restoreScreenSaver);
    }

    // Watch for dynamically created media elements
    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            m.addedNodes.forEach(function (node) {
                if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
                    attachMediaListeners(node);
                }
                if (node.querySelectorAll) {
                    node.querySelectorAll('audio, video').forEach(attachMediaListeners);
                }
            });
        });
    });

    window.addEventListener('load', function () {
        tizen.tvinputdevice.registerKey('MediaPlay');
        tizen.tvinputdevice.registerKey('MediaPause');
        tizen.tvinputdevice.registerKey('MediaStop');
        tizen.tvinputdevice.registerKey('MediaTrackPrevious');
        tizen.tvinputdevice.registerKey('MediaTrackNext');
        tizen.tvinputdevice.registerKey('MediaRewind');
        tizen.tvinputdevice.registerKey('MediaFastForward');

        document.querySelectorAll('audio, video').forEach(attachMediaListeners);
        observer.observe(document.body, { childList: true, subtree: true });
    });

    function updateKeys() {
        if (location.hash.indexOf('/queue') !== -1 || location.hash.indexOf('/video') !== -1) {
            tizen.tvinputdevice.registerKey('MediaPlayPause');
        } else {
            tizen.tvinputdevice.unregisterKey('MediaPlayPause');
        }
    }

    window.addEventListener('viewshow', updateKeys);
})();
