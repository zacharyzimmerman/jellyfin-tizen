(function () {
    'use strict';

    console.log('Tizen adapter');

    // On-screen debug overlay — shows log messages directly on the TV
    var _debugOverlay = null;
    var _debugLines = [];
    var _MAX_DEBUG_LINES = 25;
    function debugLog(msg) {
        var text = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
        var ts = new Date().toLocaleTimeString('en-US', { hour12: false }).substring(0, 8);
        var line = ts + ' ' + text;
        _debugLines.push(line);
        if (_debugLines.length > _MAX_DEBUG_LINES) _debugLines.shift();
        if (!_debugOverlay) {
            _debugOverlay = document.createElement('div');
            _debugOverlay.id = 'tizen-debug';
            _debugOverlay.style.cssText = 'position:fixed;top:0;left:0;width:38%;max-height:90vh;overflow-y:auto;' +
                'background:rgba(0,0,0,0.92);color:#0f0;font:12px/1.3 monospace;padding:6px;z-index:999999;' +
                'pointer-events:none;white-space:pre-wrap;word-break:break-all;';
            (document.body || document.documentElement).appendChild(_debugOverlay);
        }
        _debugOverlay.textContent = _debugLines.join('\n');
    }

    // Screensaver bypass: side-channel video-only MSE
    //
    // Samsung OLED TVs force a screensaver after 2 min of static pixels. The
    // firmware only suppresses it when the HARDWARE VIDEO DECODER is active.
    //
    // Previous approach (proxy pattern) intercepted createElement('audio') and
    // tried to proxy all playback through a hidden <video> with MSE. This failed
    // because jellyfin-web's htmlAudioPlayer.destroy() fires immediately after
    // play(), removing all event listeners and abandoning the player. No amount
    // of interception can prevent jellyfin-web from destroying the player.
    //
    // New approach: DON'T INTERCEPT ANYTHING. Let jellyfin-web's native audio
    // playback work 100% unmodified. Separately, when audio starts playing,
    // create a hidden <video> element and feed it H.264-only keyframes via
    // jMuxer's MSE pipeline (video-only mode, no audio track). This keeps the
    // hardware video decoder active without competing for the audio output.
    //
    // The single-element limitation may only apply when both elements produce
    // audio. A muted video-only MSE stream may coexist with native audio.

    // Pre-baked H.264 elementary stream: 128x128 black, constrained baseline, level 1.3, 1fps
    var H264_BASE64 = 'AAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABBgX//1zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIzIDA0ODBjYjAgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTE6LTM6LTMgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTIuMDA6MC43MCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTQgdGhyZWFkcz00IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTEga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTUxLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjIwAIAAAAFliIQFc5yYoAAhIybk5OTk5OTrdddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABZYiCAIM5yYoAAk1ycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAFnQsAN3CBGwEQAAAMABAAAAwAIPFCuAAAAAWjOAZRMgAAAAWWIhAIM5yYoAAk1ycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAABZ0LADdwgRsBEAAADAAQAAAMACDxQrgAAAAFozgGUTIAAAAFliIIAgznJigACTXJycnJycnJ111111111111111111111111111111111111111111111111111111114AAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABZYiEAgznJigACTXJycnJycnJ111111111111111111111111111111111111111111111111111111114A==';

    // Run MSE codec diagnostics at startup
    (function diagnoseMSE() {
        var codecs = [
            'video/mp4; codecs="avc1.42c00d"',
            'video/mp4; codecs="avc1.42c00d,mp4a.40.2"',
            'video/mp4; codecs="avc1.42E01E"',
            'audio/mp4; codecs="mp4a.40.2"',
            'video/mp4',
            'audio/mp4'
        ];
        var hasMS = typeof MediaSource !== 'undefined';
        debugLog('[DIAG] MediaSource: ' + hasMS);
        if (hasMS) {
            codecs.forEach(function (c) {
                var supported = MediaSource.isTypeSupported(c);
                debugLog('[DIAG] ' + c + ': ' + supported);
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

    // Build the H.264 keyframe data once at startup
    var h264Data = base64ToUint8Array(H264_BASE64);
    var h264Keyframe = buildKeyframe(h264Data);

    function postMessage() {
        console.log.apply(console, arguments);
        var parts = [];
        for (var a = 0; a < arguments.length; a++) {
            parts.push(typeof arguments[a] === 'object' ? JSON.stringify(arguments[a]) : String(arguments[a]));
        }
        debugLog(parts.join(' '));
    }

    // ============================================================
    // Side-channel video-only MSE: keeps hardware decoder active
    // without interfering with jellyfin-web's audio playback
    // ============================================================

    var _sideChannelVideo = null;
    var _sideChannelJMuxer = null;
    var _sideChannelInterval = null;
    var _sideChannelActive = false;

    function startSideChannel() {
        if (_sideChannelActive) {
            debugLog('[SIDE] already active');
            return;
        }

        if (!h264Keyframe) {
            debugLog('[SIDE] no H.264 keyframe data');
            return;
        }

        if (typeof JMuxer === 'undefined') {
            debugLog('[SIDE] JMuxer not loaded');
            return;
        }

        if (typeof MediaSource === 'undefined') {
            debugLog('[SIDE] MediaSource not available');
            return;
        }

        var videoOnlyType = 'video/mp4; codecs="avc1.42c00d"';
        if (!MediaSource.isTypeSupported(videoOnlyType)) {
            debugLog('[SIDE] video-only MSE not supported');
            return;
        }

        debugLog('[SIDE] starting video-only MSE');
        _sideChannelActive = true;

        // Create hidden video element
        var videoEl = document.createElement('video');
        videoEl.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
        videoEl.setAttribute('playsinline', '');
        videoEl.muted = true; // critical: no audio output from this element
        videoEl.volume = 0;
        document.body.appendChild(videoEl);
        _sideChannelVideo = videoEl;

        try {
            var jmuxer = new JMuxer({
                node: videoEl,
                mode: 'video',  // VIDEO ONLY — no audio track
                fps: 1,
                flushingTime: 1000,
                maxDelay: 5000,
                clearBuffer: false,
                debug: false,
                onReady: function () {
                    debugLog('[SIDE] MSE ready — feeding initial keyframes');
                    try {
                        // Feed initial H.264 data to set up the video track
                        jmuxer.feed({ video: h264Data, duration: 1000 });

                        // Start periodic keyframe feeding (1 fps)
                        _sideChannelInterval = setInterval(function () {
                            if (_sideChannelJMuxer && _sideChannelActive) {
                                try {
                                    _sideChannelJMuxer.feed({ video: h264Keyframe, duration: 1000 });
                                } catch (e) {
                                    debugLog('[SIDE] feed error: ' + e.message);
                                }
                            }
                        }, 1000);

                        // Try to play the video
                        videoEl.play().then(function () {
                            debugLog('[SIDE] video playing');
                        }).catch(function (e) {
                            debugLog('[SIDE] play error: ' + e.message);
                        });
                    } catch (e) {
                        debugLog('[SIDE] init feed error: ' + e.message);
                        stopSideChannel();
                    }
                },
                onError: function (err) {
                    debugLog('[SIDE] jMuxer error: ' + JSON.stringify(err));
                    stopSideChannel();
                }
            });
            _sideChannelJMuxer = jmuxer;
        } catch (e) {
            debugLog('[SIDE] jMuxer init error: ' + e.message);
            _sideChannelActive = false;
            if (_sideChannelVideo && _sideChannelVideo.parentNode) {
                _sideChannelVideo.parentNode.removeChild(_sideChannelVideo);
            }
            _sideChannelVideo = null;
        }
    }

    function stopSideChannel() {
        if (!_sideChannelActive) return;

        debugLog('[SIDE] stopping video-only MSE');
        _sideChannelActive = false;

        if (_sideChannelInterval) {
            clearInterval(_sideChannelInterval);
            _sideChannelInterval = null;
        }

        if (_sideChannelJMuxer) {
            try { _sideChannelJMuxer.destroy(); } catch (e) { /* ignore */ }
            _sideChannelJMuxer = null;
        }

        if (_sideChannelVideo) {
            try { _sideChannelVideo.pause(); } catch (e) { /* ignore */ }
            if (_sideChannelVideo.parentNode) {
                _sideChannelVideo.parentNode.removeChild(_sideChannelVideo);
            }
            _sideChannelVideo = null;
        }
    }

    // ============================================================
    // Attach to audio elements: start side-channel when playing,
    // stop when paused/ended
    // ============================================================

    function onAudioPlaying(e) {
        var el = e.target;
        debugLog('[SIDE] audio playing event from ' + (el.src || '').substring(0, 60));
        // Only start side-channel for actual audio content
        if (el.src && /\/Audio\//i.test(el.src)) {
            debugLog('[SIDE] audio URL detected — starting side channel');
            startSideChannel();
        } else {
            debugLog('[SIDE] non-audio URL, skipping side channel');
        }
    }

    function onAudioPaused() {
        debugLog('[SIDE] audio paused');
        stopSideChannel();
    }

    function onAudioEnded() {
        debugLog('[SIDE] audio ended');
        stopSideChannel();
    }

    // ============================================================
    // Standard Tizen adapter (NativeShell, AppHost, etc.)
    // ============================================================

    function generateDeviceId() {
        return btoa([navigator.userAgent, new Date().getTime()].join('|')).replace(/=/g, '1');
    }

    function getDeviceId() {
        var deviceId = localStorage.getItem('_deviceId2');
        if (!deviceId) {
            deviceId = generateDeviceId();
            localStorage.setItem('_deviceId2', deviceId);
        }
        return deviceId;
    }

    // Ensure server address is pre-filled
    var SERVER_URL = 'https://movies.great-tags.com';
    var SERVER_NAME = 'Jellyfin';

    (function preFillServer() {
        var creds = localStorage.getItem('jellyfin_credentials');
        var data = null;
        try { data = creds ? JSON.parse(creds) : null; } catch (e) { /* ignore */ }
        if (!data) data = { Servers: [] };
        if (!data.Servers) data.Servers = [];

        var entry = null;
        for (var i = 0; i < data.Servers.length; i++) {
            if (data.Servers[i].ManualAddress === SERVER_URL) {
                entry = data.Servers[i];
                break;
            }
        }
        if (!entry) {
            entry = {
                Id: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'.replace(/x/g, function () {
                    return (Math.random() * 16 | 0).toString(16);
                }),
                ManualAddress: SERVER_URL,
                LastConnectionMode: 2,
                manualAddressOnly: true
            };
            data.Servers.unshift(entry);
        }
        entry.Name = SERVER_NAME;
        entry.DateLastAccessed = Date.now();

        localStorage.setItem('jellyfin_credentials', JSON.stringify(data));
        postMessage('serverPreFill', 'server entry saved (manual login)');
    })();

    var AppInfo = {
        deviceId: getDeviceId(),
        deviceName: 'Samsung Smart TV',
        appName: 'Jellyfin for Tizen',
        appVersion: tizen.application.getCurrentApplication().appInfo.version
    };

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

                resolve(systeminfo);
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
                stopSideChannel();

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

        // Standard screensaver API calls
        el.addEventListener('playing', suppressScreenSaver);
        el.addEventListener('pause', restoreScreenSaver);
        el.addEventListener('ended', restoreScreenSaver);
        el.addEventListener('emptied', restoreScreenSaver);

        // Side-channel: start/stop video-only MSE alongside audio
        if (el.nodeName === 'AUDIO') {
            debugLog('[SIDE] attaching side-channel listeners to <audio>');
            el.addEventListener('playing', onAudioPlaying);
            el.addEventListener('pause', onAudioPaused);
            el.addEventListener('ended', onAudioEnded);
            el.addEventListener('emptied', onAudioEnded);
        }
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
