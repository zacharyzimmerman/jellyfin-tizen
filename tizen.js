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

    // Expose debugLog globally
    window.__tizenDebug = debugLog;

    // Intercept console.debug and console.error to capture diagnostics in overlay
    var _origDebug = console.debug;
    console.debug = function() {
        _origDebug.apply(console, arguments);
        var msg = Array.prototype.slice.call(arguments).join(' ');
        if (msg.indexOf('[TIZEN') !== -1) {
            debugLog(msg);
        }
    };
    var _origError = console.error;
    console.error = function() {
        _origError.apply(console, arguments);
        var msg = Array.prototype.slice.call(arguments).join(' ');
        if (msg.indexOf('[TIZEN') !== -1 || msg.indexOf('MEDIA_ELEMENT') !== -1 || msg.indexOf('media element error') !== -1) {
            debugLog('ERR: ' + msg);
        }
    };

    function postMessage() {
        console.log.apply(console, arguments);
        var parts = [];
        for (var a = 0; a < arguments.length; a++) {
            parts.push(typeof arguments[a] === 'object' ? JSON.stringify(arguments[a]) : String(arguments[a]));
        }
        debugLog(parts.join(' '));
    }

    // ============================================================
    // OLED Screensaver Bypass
    // ============================================================
    //
    // Samsung OLED TVs have firmware-level burn-in protection that
    // activates after ~2 minutes of static pixels, regardless of
    // what apps request via setScreenSaver API. The only reliable
    // way to prevent it is to have CHANGING PIXELS on the display.
    //
    // Strategy: When audio playback starts, show a fullscreen
    // <video> element behind the Jellyfin UI that loops a subtle
    // dark animation (screensaver-bypass.mp4). The video content
    // produces barely-visible pixel changes that tell the firmware
    // real video is playing. Combined with setScreenSaver(OFF) and
    // tizen.power.request() for belt-and-suspenders coverage.
    //
    // screensaver-bypass.mp4 specs:
    //   128x72, H.264 Baseline, 2fps, 60s loop, ~25KB
    //   Dark sine-wave pattern (luma 16-45, barely visible on OLED)

    var _bypassVideo = null;
    var _bypassActive = false;
    var _screenSaverInterval = null;

    function createBypassVideo() {
        if (_bypassVideo) return _bypassVideo;

        var v = document.createElement('video');
        v.id = 'tizen-screensaver-bypass';
        v.setAttribute('playsinline', '');
        v.setAttribute('muted', '');
        v.muted = true;
        v.loop = true;
        v.volume = 0;
        // Position behind all UI content — Jellyfin UI has z-index layers
        // but this sits at the very back
        v.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
            'z-index:-1;object-fit:cover;pointer-events:none;opacity:1;';
        v.src = '../screensaver-bypass.mp4';

        // Preload so it's ready when needed
        v.preload = 'auto';
        v.load();

        (document.body || document.documentElement).appendChild(v);
        _bypassVideo = v;

        debugLog('[BYPASS] created bypass video element');
        return v;
    }

    function startBypass() {
        if (_bypassActive) return;
        _bypassActive = true;

        var v = createBypassVideo();
        v.style.display = 'block';

        var playPromise = v.play();
        if (playPromise && playPromise.catch) {
            playPromise.then(function () {
                debugLog('[BYPASS] video playing');
            }).catch(function (e) {
                debugLog('[BYPASS] play failed: ' + e.message);
            });
        }

        // Also suppress via API (belt and suspenders)
        suppressScreenSaver();

        // Periodic API suppression every 30s
        if (!_screenSaverInterval) {
            _screenSaverInterval = setInterval(function () {
                if (_bypassActive) suppressScreenSaver();
            }, 30000);
        }

        debugLog('[BYPASS] started');
    }

    function stopBypass() {
        if (!_bypassActive) return;
        _bypassActive = false;

        if (_bypassVideo) {
            _bypassVideo.pause();
            _bypassVideo.style.display = 'none';
        }

        if (_screenSaverInterval) {
            clearInterval(_screenSaverInterval);
            _screenSaverInterval = null;
        }

        restoreScreenSaver();
        debugLog('[BYPASS] stopped');
    }

    // ============================================================
    // Screensaver API calls (secondary defense)
    // ============================================================

    function suppressScreenSaver() {
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                function () { /* quiet */ },
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

        // Also write to the server input field if on the add-server page
        // jellyfin-web 10.10.x uses #txtServerHost
        var prefillAttempts = 0;
        var prefillTimer = setInterval(function () {
            prefillAttempts++;
            var input = document.querySelector('#txtServerHost');
            if (input && !input.value) {
                input.value = SERVER_URL;
                var evt = new Event('input', { bubbles: true });
                input.dispatchEvent(evt);
                debugLog('[PREFILL] auto-filled #txtServerHost');
                clearInterval(prefillTimer);
            } else if (input && input.value) {
                clearInterval(prefillTimer);
            } else if (prefillAttempts >= 10) {
                clearInterval(prefillTimer);
            }
        }, 500);

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
                stopBypass();
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
            suppressScreenSaver();
        },

        hideMediaSession: function () {
            postMessage('hideMediaSession');
            restoreScreenSaver();
        }
    };

    // ============================================================
    // Media element listeners — start/stop bypass video on audio
    // ============================================================

    function isAudioElement(el) {
        return el.nodeName === 'AUDIO' ||
            (el.nodeName === 'VIDEO' && el.classList.contains('mediaPlayerAudio'));
    }

    function isVideoPlayback(el) {
        // Real video playback (movies, shows) — not our bypass video
        return el.nodeName === 'VIDEO' &&
            !el.classList.contains('mediaPlayerAudio') &&
            el.id !== 'tizen-screensaver-bypass';
    }

    function attachMediaListeners(el) {
        if (el._tizenListenersAttached) return;
        if (el.id === 'tizen-screensaver-bypass') return; // Skip our own bypass video
        el._tizenListenersAttached = true;

        var tag = el.nodeName;
        var classes = el.className || '';
        debugLog('[MEDIA] attaching to <' + tag + '> class="' + classes + '"');

        el.addEventListener('playing', function () {
            var src = (el.src || el.currentSrc || '').substring(0, 80);
            debugLog('[MEDIA] <' + tag + '> playing — ' + src);

            if (isAudioElement(el)) {
                // Audio playback — start bypass video for OLED
                debugLog('[MEDIA] audio detected, starting bypass');
                startBypass();
            } else if (isVideoPlayback(el)) {
                // Real video — just suppress screensaver via API
                suppressScreenSaver();
            }
        });

        el.addEventListener('pause', function () {
            debugLog('[MEDIA] <' + tag + '> paused');
            if (isAudioElement(el)) {
                stopBypass();
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
        });

        el.addEventListener('ended', function () {
            debugLog('[MEDIA] <' + tag + '> ended');
            if (isAudioElement(el)) {
                stopBypass();
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
        });

        el.addEventListener('emptied', function () {
            debugLog('[MEDIA] <' + tag + '> emptied');
            if (isAudioElement(el)) {
                stopBypass();
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
        });

        // Diagnostics
        el.addEventListener('error', function () {
            var code = el.error ? el.error.code : 0;
            var msg = el.error ? el.error.message : '';
            debugLog('[MEDIA] <' + tag + '> error: ' + code + ' ' + msg);
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

        // Pre-create the bypass video element (preloads the mp4)
        createBypassVideo();
        debugLog('[INIT] bypass video preloaded');
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
