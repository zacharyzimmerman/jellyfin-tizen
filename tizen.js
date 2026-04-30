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

    // Expose debugLog globally so the patched webpack bundle can use it
    window.__tizenDebug = debugLog;

    // Intercept console.debug and console.error to capture [TIZEN-MSE] messages in overlay
    var _origDebug = console.debug;
    console.debug = function() {
        _origDebug.apply(console, arguments);
        var msg = Array.prototype.slice.call(arguments).join(' ');
        if (msg.indexOf('[TIZEN-MSE]') !== -1) {
            debugLog(msg);
        }
    };
    var _origError = console.error;
    console.error = function() {
        _origError.apply(console, arguments);
        var msg = Array.prototype.slice.call(arguments).join(' ');
        if (msg.indexOf('[TIZEN-MSE]') !== -1 || msg.indexOf('MEDIA_ELEMENT') !== -1 || msg.indexOf('media element error') !== -1) {
            debugLog('ERR: ' + msg);
        }
    };

    // Screensaver bypass strategy (Build 38):
    //
    // The jellyfin-web htmlAudioPlayer plugin has been PATCHED at build time
    // (patches/apply-tizen-video-patch.cjs) to:
    //   1. Create <video> instead of <audio> on Tizen (browser.tizen detection)
    //   2. Route audio URLs through jMuxer MSE (H.264 @ 15fps + AAC) so the
    //      hardware video decoder is continuously active during audio playback
    //   3. Clean up jMuxer on destroy()/stop()
    //
    // tizen.js provides:
    //   - NativeShell/AppHost adapter (required by jellyfin-web)
    //   - Server pre-fill for https://movies.great-tags.com
    //   - Screensaver API calls (AppCommon + Power API) — both event-driven
    //     AND periodic (every 30s via global hooks called by the MSE patch)
    //   - Debug overlay for on-TV diagnostics
    //   - jMuxer availability check (loaded via <script> tag in index.html)

    // Verify jMuxer is loaded (injected by gulpfile into index.html)
    if (typeof JMuxer !== 'undefined') {
        debugLog('[INIT] JMuxer loaded: v' + (JMuxer.version || 'unknown'));
    } else {
        debugLog('[INIT] WARNING: JMuxer not loaded — MSE patch will fall back to native audio');
    }

    // MSE codec diagnostics
    (function diagnoseMSE() {
        var codecs = [
            'video/mp4; codecs="avc1.42c00d"',
            'video/mp4; codecs="avc1.42c00d,mp4a.40.2"',
            'audio/mp4; codecs="mp4a.40.2"'
        ];
        var hasMS = typeof MediaSource !== 'undefined';
        debugLog('[DIAG] MediaSource: ' + hasMS);
        if (hasMS) {
            codecs.forEach(function (c) {
                debugLog('[DIAG] ' + c + ': ' + MediaSource.isTypeSupported(c));
            });
        }
    })();

    function postMessage() {
        console.log.apply(console, arguments);
        var parts = [];
        for (var a = 0; a < arguments.length; a++) {
            parts.push(typeof arguments[a] === 'object' ? JSON.stringify(arguments[a]) : String(arguments[a]));
        }
        debugLog(parts.join(' '));
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

    // Ensure server address is pre-filled so the user doesn't have to type it
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
            if (data.Servers[i].ManualAddress === SERVER_URL ||
                data.Servers[i].LocalAddress === SERVER_URL) {
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
                LocalAddress: SERVER_URL,
                LastConnectionMode: 2,
                manualAddressOnly: true
            };
            data.Servers.unshift(entry);
        }
        // Always update these fields to keep the entry fresh
        entry.Name = SERVER_NAME;
        entry.ManualAddress = SERVER_URL;
        entry.LocalAddress = SERVER_URL;
        entry.DateLastAccessed = Date.now();
        entry.LastConnectionMode = 2;

        localStorage.setItem('jellyfin_credentials', JSON.stringify(data));

        // Also write to the server input field if on the login/connect page
        // The jellyfin-web connect page has an input with id 'txtServerAddress'
        setTimeout(function () {
            var input = document.querySelector('#txtServerAddress');
            if (input && !input.value) {
                input.value = SERVER_URL;
                // Trigger input event so React/jellyfin-web picks up the value
                var evt = new Event('input', { bubbles: true });
                input.dispatchEvent(evt);
                debugLog('[PREFILL] auto-filled server address input');
            }
        }, 2000);

        debugLog('[PREFILL] server entry saved: ' + SERVER_URL);
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

    // Screensaver suppression using both AppCommon and Power API
    // Called on media events AND periodically (every 30s) by the MSE patch
    function suppressScreenSaver() {
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                function () { /* quiet — logged only on first call per session */ },
                function (err) { debugLog('setScreenSaver OFF err: ' + JSON.stringify(err)); }
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
                function () { /* quiet */ },
                function (err) { debugLog('setScreenSaver ON err: ' + JSON.stringify(err)); }
            );
        } catch (e) { /* ignore */ }

        try {
            tizen.power.release('SCREEN');
        } catch (e) { /* ignore */ }
    }

    // Expose globally so the MSE patch (inside webpack bundle) can call them
    window.__tizenSuppressScreenSaver = suppressScreenSaver;
    window.__tizenRestoreScreenSaver = restoreScreenSaver;

    function attachMediaListeners(el) {
        if (el._tizenListenersAttached) return;
        el._tizenListenersAttached = true;

        var tag = el.nodeName;
        debugLog('[MEDIA] attaching listeners to <' + tag + '>');

        // Standard screensaver API calls
        el.addEventListener('playing', function () {
            debugLog('[MEDIA] <' + tag + '> playing — src=' + (el.src || '').substring(0, 60));
            suppressScreenSaver();
        });
        el.addEventListener('pause', function () {
            debugLog('[MEDIA] <' + tag + '> paused');
            restoreScreenSaver();
        });
        el.addEventListener('ended', function () {
            debugLog('[MEDIA] <' + tag + '> ended');
            restoreScreenSaver();
        });
        el.addEventListener('emptied', function () {
            debugLog('[MEDIA] <' + tag + '> emptied');
            restoreScreenSaver();
        });

        // Log MSE-related events for diagnostics
        el.addEventListener('error', function () {
            var code = el.error ? el.error.code : 0;
            var msg = el.error ? el.error.message : '';
            debugLog('[MEDIA] <' + tag + '> error: ' + code + ' ' + msg);
        });
        el.addEventListener('canplay', function () {
            debugLog('[MEDIA] <' + tag + '> canplay');
        });
        el.addEventListener('loadeddata', function () {
            debugLog('[MEDIA] <' + tag + '> loadeddata');
        });
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
