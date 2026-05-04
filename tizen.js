(function () {
    'use strict';

    console.log('Tizen adapter');

    // Debug logging — console only (no on-screen overlay)
    function debugLog(msg) {
        var text = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
        console.log('[TIZEN] ' + text);
    }

    function postMessage() {
        // Quiet — only log to console for remote debugging
        var parts = [];
        for (var a = 0; a < arguments.length; a++) {
            parts.push(typeof arguments[a] === 'object' ? JSON.stringify(arguments[a]) : String(arguments[a]));
        }
        console.log('[TIZEN] ' + parts.join(' '));
    }

    // ============================================================
    // OLED Screensaver Bypass
    // ============================================================
    //
    // Samsung OLED TVs have firmware-level burn-in protection that
    // activates after ~2 minutes of static pixels. The only reliable
    // way to prevent it is to have CHANGING PIXELS on the display.
    //
    // Strategy: When audio playback starts, show a fullscreen
    // <video> element behind the Jellyfin UI that loops a subtle
    // dark animation (screensaver-bypass.mp4). Combined with
    // setScreenSaver(OFF) and tizen.power.request() as secondary.
    //
    // screensaver-bypass.mp4: 128x72 H.264 Baseline, 2fps, 60s, ~25KB

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
        v.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
            'z-index:-1;object-fit:cover;pointer-events:none;opacity:1;';
        v.src = '../screensaver-bypass.mp4';
        v.preload = 'auto';
        v.load();

        (document.body || document.documentElement).appendChild(v);
        _bypassVideo = v;
        debugLog('bypass video element created');
        return v;
    }

    function startBypass() {
        if (_bypassActive) return;
        _bypassActive = true;

        var v = createBypassVideo();
        v.style.display = 'block';
        var p = v.play();
        if (p && p.catch) p.catch(function () {});

        suppressScreenSaver();
        if (!_screenSaverInterval) {
            _screenSaverInterval = setInterval(function () {
                if (_bypassActive) suppressScreenSaver();
            }, 30000);
        }
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
    }

    // ============================================================
    // Screensaver API (secondary defense)
    // ============================================================

    function suppressScreenSaver() {
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                function () {},
                function () {}
            );
        } catch (e) {}
        try { tizen.power.request('SCREEN', 'SCREEN_NORMAL'); } catch (e) {}
    }

    function restoreScreenSaver() {
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON,
                function () {},
                function () {}
            );
        } catch (e) {}
        try { tizen.power.release('SCREEN'); } catch (e) {}
    }

    // ============================================================
    // Now-Playing Overlay (album art screen)
    // ============================================================
    //
    // Fullscreen overlay that shows album art, track info, and
    // progress during audio playback. Displayed on top of the
    // Jellyfin UI when audio is playing. The user can dismiss it
    // with the Back button and re-show it from the now-playing bar.

    var _overlay = null;
    var _overlayVisible = false;
    var _currentMediaInfo = null;
    var _progressInterval = null;
    var _playbackStartTime = 0;
    var _playbackPosition = 0;
    var _isPaused = false;

    function createOverlay() {
        if (_overlay) return _overlay;

        var el = document.createElement('div');
        el.id = 'tizen-now-playing';
        el.innerHTML =
            '<div class="tnp-bg"></div>' +
            '<div class="tnp-content">' +
                '<div class="tnp-art-wrap"><img class="tnp-art" src="" alt=""></div>' +
                '<div class="tnp-info">' +
                    '<div class="tnp-title"></div>' +
                    '<div class="tnp-artist"></div>' +
                    '<div class="tnp-album"></div>' +
                '</div>' +
                '<div class="tnp-progress-wrap">' +
                    '<div class="tnp-time tnp-time-current">0:00</div>' +
                    '<div class="tnp-bar"><div class="tnp-bar-fill"></div></div>' +
                    '<div class="tnp-time tnp-time-total">0:00</div>' +
                '</div>' +
                '<div class="tnp-controls">' +
                    '<div class="tnp-btn" data-action="prev">⏮</div>' +
                    '<div class="tnp-btn tnp-btn-play" data-action="playpause">⏸</div>' +
                    '<div class="tnp-btn" data-action="next">⏭</div>' +
                '</div>' +
            '</div>';

        var style = document.createElement('style');
        style.textContent =
            '#tizen-now-playing {' +
                'position:fixed;top:0;left:0;width:100vw;height:100vh;' +
                'z-index:99999;display:none;' +
            '}' +
            '#tizen-now-playing.visible { display:flex; }' +
            '.tnp-bg {' +
                'position:absolute;top:0;left:0;width:100%;height:100%;' +
                'background-size:cover;background-position:center;' +
                'filter:blur(40px) brightness(0.3);' +
                'transform:scale(1.2);' +
            '}' +
            '.tnp-content {' +
                'position:relative;z-index:1;width:100%;height:100%;' +
                'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
                'padding:40px;box-sizing:border-box;' +
            '}' +
            '.tnp-art-wrap {' +
                'width:400px;height:400px;border-radius:8px;overflow:hidden;' +
                'box-shadow:0 16px 48px rgba(0,0,0,0.6);margin-bottom:32px;' +
                'background:#222;' +
            '}' +
            '.tnp-art {' +
                'width:100%;height:100%;object-fit:cover;display:block;' +
            '}' +
            '.tnp-info {' +
                'text-align:center;margin-bottom:24px;max-width:600px;' +
            '}' +
            '.tnp-title {' +
                'font-size:28px;font-weight:600;color:#fff;' +
                'margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            '}' +
            '.tnp-artist {' +
                'font-size:20px;color:rgba(255,255,255,0.8);' +
                'margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            '}' +
            '.tnp-album {' +
                'font-size:16px;color:rgba(255,255,255,0.5);' +
                'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
            '}' +
            '.tnp-progress-wrap {' +
                'display:flex;align-items:center;width:500px;max-width:80vw;margin-bottom:24px;' +
            '}' +
            '.tnp-time {' +
                'font-size:14px;color:rgba(255,255,255,0.6);min-width:44px;' +
                'font-variant-numeric:tabular-nums;' +
            '}' +
            '.tnp-time-current { text-align:right;margin-right:12px; }' +
            '.tnp-time-total { text-align:left;margin-left:12px; }' +
            '.tnp-bar {' +
                'flex:1;height:4px;background:rgba(255,255,255,0.2);border-radius:2px;' +
                'overflow:hidden;' +
            '}' +
            '.tnp-bar-fill {' +
                'height:100%;background:#00a4dc;border-radius:2px;width:0%;' +
                'transition:width 1s linear;' +
            '}' +
            '.tnp-controls {' +
                'display:flex;align-items:center;gap:32px;' +
            '}' +
            '.tnp-btn {' +
                'font-size:32px;color:rgba(255,255,255,0.8);cursor:pointer;' +
                'padding:8px;user-select:none;' +
            '}' +
            '.tnp-btn-play { font-size:44px; }' +
            '.tnp-btn:focus,.tnp-btn:hover { color:#00a4dc; }';

        document.head.appendChild(style);
        (document.body || document.documentElement).appendChild(el);
        _overlay = el;
        return el;
    }

    function formatTime(ms) {
        if (!ms || ms < 0) return '0:00';
        var totalSec = Math.floor(ms / 1000);
        var min = Math.floor(totalSec / 60);
        var sec = totalSec % 60;
        return min + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function updateOverlayContent(info) {
        if (!_overlay) createOverlay();

        var art = _overlay.querySelector('.tnp-art');
        var bg = _overlay.querySelector('.tnp-bg');
        var title = _overlay.querySelector('.tnp-title');
        var artist = _overlay.querySelector('.tnp-artist');
        var album = _overlay.querySelector('.tnp-album');
        var totalTime = _overlay.querySelector('.tnp-time-total');
        var playBtn = _overlay.querySelector('.tnp-btn-play');

        if (info.imageUrl) {
            art.src = info.imageUrl;
            bg.style.backgroundImage = 'url(' + info.imageUrl + ')';
        } else {
            art.src = '';
            bg.style.backgroundImage = 'none';
            bg.style.background = '#111';
        }

        title.textContent = info.title || '';
        artist.textContent = info.artist || '';
        album.textContent = info.album || '';
        totalTime.textContent = formatTime(info.duration);

        _isPaused = !!info.isPaused;
        playBtn.textContent = _isPaused ? '▶' : '⏸';

        if (typeof info.position === 'number') {
            _playbackPosition = info.position;
            _playbackStartTime = Date.now();
        }
        updateProgress();
    }

    function updateProgress() {
        if (!_overlay || !_currentMediaInfo) return;

        var elapsed = _isPaused ? 0 : (Date.now() - _playbackStartTime);
        var current = _playbackPosition + elapsed;
        var duration = _currentMediaInfo.duration || 1;
        var pct = Math.min(100, (current / duration) * 100);

        var fill = _overlay.querySelector('.tnp-bar-fill');
        var curTime = _overlay.querySelector('.tnp-time-current');
        if (fill) fill.style.width = pct + '%';
        if (curTime) curTime.textContent = formatTime(current);
    }

    function showOverlay() {
        if (!_overlay) createOverlay();
        _overlay.classList.add('visible');
        _overlayVisible = true;

        if (!_progressInterval) {
            _progressInterval = setInterval(updateProgress, 1000);
        }
    }

    function hideOverlay() {
        if (_overlay) _overlay.classList.remove('visible');
        _overlayVisible = false;

        if (_progressInterval) {
            clearInterval(_progressInterval);
            _progressInterval = null;
        }
    }

    // Transport control helpers — try multiple API paths
    function execTransport(action) {
        debugLog('transport: ' + action);
        try {
            // jellyfin-web 10.10.x exposes playbackManager on Events object
            // or as a requirejs module. Try known global paths:
            var pm = null;

            // Path 1: Emby global (common in 10.8+)
            if (window.Emby && window.Emby.PlaybackManager) {
                pm = window.Emby.PlaybackManager;
            }

            if (pm) {
                switch (action) {
                    case 'playpause': pm.playPause(); break;
                    case 'next': pm.nextTrack(); break;
                    case 'prev': pm.previousTrack(); break;
                }
                return;
            }

            // Path 2: Dispatch media key events (works with jellyfin-web's key handler)
            var keyMap = {
                'playpause': 'MediaPlayPause',
                'next': 'MediaTrackNext',
                'prev': 'MediaTrackPrevious'
            };
            if (keyMap[action]) {
                document.dispatchEvent(new KeyboardEvent('keydown', {
                    key: keyMap[action],
                    bubbles: true
                }));
            }
        } catch (e) {
            debugLog('transport error: ' + e.message);
        }
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

    var SERVER_URL = 'https://movies.great-tags.com';
    var SERVER_NAME = 'Jellyfin';

    (function preFillServer() {
        var creds = localStorage.getItem('jellyfin_credentials');
        var data = null;
        try { data = creds ? JSON.parse(creds) : null; } catch (e) {}
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
        entry.Name = SERVER_NAME;
        entry.ManualAddress = SERVER_URL;
        entry.LocalAddress = SERVER_URL;
        entry.DateLastAccessed = Date.now();
        entry.LastConnectionMode = 2;

        localStorage.setItem('jellyfin_credentials', JSON.stringify(data));

        var prefillAttempts = 0;
        var prefillTimer = setInterval(function () {
            prefillAttempts++;
            var input = document.querySelector('#txtServerHost');
            if (input && !input.value) {
                input.value = SERVER_URL;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                clearInterval(prefillTimer);
            } else if ((input && input.value) || prefillAttempts >= 10) {
                clearInterval(prefillTimer);
            }
        }, 500);
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
        if (systeminfo) return Promise.resolve(systeminfo);

        return new Promise(function (resolve) {
            tizen.systeminfo.getPropertyValue('DISPLAY', function (result) {
                var devicePixelRatio = 1;
                if (typeof webapis.productinfo.is8KPanelSupported === 'function' && webapis.productinfo.is8KPanelSupported()) {
                    devicePixelRatio = 4;
                } else if (typeof webapis.productinfo.isUdPanelSupported === 'function' && webapis.productinfo.isUdPanelSupported()) {
                    devicePixelRatio = 2;
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

            appName: function () { return AppInfo.appName; },
            appVersion: function () { return AppInfo.appVersion; },
            deviceId: function () { return AppInfo.deviceId; },
            deviceName: function () { return AppInfo.deviceName; },

            exit: function () {
                postMessage('AppHost.exit');
                stopBypass();
                hideOverlay();
                tizen.application.getCurrentApplication().exit();
            },

            getDefaultLayout: function () { return 'tv'; },

            getDeviceProfile: function (profileBuilder) {
                return profileBuilder({ enableMkvProgressive: false, enableSsaRender: true });
            },

            getSyncProfile: function (profileBuilder) {
                return profileBuilder({ enableMkvProgressive: false });
            },

            screen: function () {
                return systeminfo ? {
                    width: systeminfo.resolutionWidth,
                    height: systeminfo.resolutionHeight
                } : null;
            },

            supports: function (command) {
                return command && SupportedFeatures.indexOf(command.toLowerCase()) !== -1;
            }
        },

        downloadFile: function () {},
        enableFullscreen: function () {},
        disableFullscreen: function () {},
        getPlugins: function () { return []; },
        openUrl: function () {},

        updateMediaSession: function (mediaInfo) {
            debugLog('updateMediaSession: ' + (mediaInfo ? mediaInfo.title : 'null'));
            suppressScreenSaver();

            if (mediaInfo) {
                _currentMediaInfo = mediaInfo;
                updateOverlayContent(mediaInfo);

                // Auto-show overlay on first play
                if (!_overlayVisible && mediaInfo.action === 'play') {
                    showOverlay();
                }
            }
        },

        hideMediaSession: function () {
            debugLog('hideMediaSession');
            _currentMediaInfo = null;
            hideOverlay();
            restoreScreenSaver();
        }
    };

    // ============================================================
    // Media element listeners — start/stop bypass on audio
    // ============================================================

    function isAudioElement(el) {
        return el.nodeName === 'AUDIO' ||
            (el.nodeName === 'VIDEO' && el.classList.contains('mediaPlayerAudio'));
    }

    function isVideoPlayback(el) {
        return el.nodeName === 'VIDEO' &&
            !el.classList.contains('mediaPlayerAudio') &&
            el.id !== 'tizen-screensaver-bypass';
    }

    function attachMediaListeners(el) {
        if (el._tizenListenersAttached) return;
        if (el.id === 'tizen-screensaver-bypass') return;
        el._tizenListenersAttached = true;

        el.addEventListener('playing', function () {
            if (isAudioElement(el)) {
                startBypass();
            } else if (isVideoPlayback(el)) {
                suppressScreenSaver();
                // Hide now-playing overlay during video playback
                hideOverlay();
            }
        });

        el.addEventListener('pause', function () {
            if (isAudioElement(el)) {
                // Don't stop bypass on pause — user may resume
                // Just update play/pause button
                _isPaused = true;
                _playbackPosition = _playbackPosition + (Date.now() - _playbackStartTime);
                _playbackStartTime = Date.now();
                if (_overlay) {
                    var btn = _overlay.querySelector('.tnp-btn-play');
                    if (btn) btn.textContent = '▶';
                }
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
        });

        el.addEventListener('ended', function () {
            if (isAudioElement(el)) {
                // Track ended — next track will trigger new updateMediaSession
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
        });

        el.addEventListener('emptied', function () {
            if (isAudioElement(el)) {
                stopBypass();
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
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

    // ============================================================
    // Key handling for overlay transport controls
    // ============================================================

    document.addEventListener('keydown', function (e) {
        // Only intercept keys when our overlay is visible
        if (!_overlayVisible) return;

        switch (e.keyCode) {
            case 415: // MediaPlay
            case 10252: // MediaPlayPause
                execTransport('playpause');
                e.preventDefault();
                e.stopPropagation();
                break;
            case 19: // MediaPause
                execTransport('playpause');
                e.preventDefault();
                e.stopPropagation();
                break;
            case 10232: // MediaTrackPrevious
            case 10233: // MediaRewind (use as prev)
                execTransport('prev');
                e.preventDefault();
                e.stopPropagation();
                break;
            case 10234: // MediaTrackNext
            case 10228: // MediaFastForward (use as next)
                execTransport('next');
                e.preventDefault();
                e.stopPropagation();
                break;
            case 10009: // Back button
            case 27: // Escape
                hideOverlay();
                e.preventDefault();
                e.stopPropagation();
                break;
            case 13: // Enter/OK — toggle play/pause
                execTransport('playpause');
                e.preventDefault();
                e.stopPropagation();
                break;
        }
    }, true); // Use capture phase to intercept before jellyfin-web

    // ============================================================
    // Initialization
    // ============================================================

    window.addEventListener('load', function () {
        tizen.tvinputdevice.registerKey('MediaPlay');
        tizen.tvinputdevice.registerKey('MediaPause');
        tizen.tvinputdevice.registerKey('MediaStop');
        tizen.tvinputdevice.registerKey('MediaTrackPrevious');
        tizen.tvinputdevice.registerKey('MediaTrackNext');
        tizen.tvinputdevice.registerKey('MediaRewind');
        tizen.tvinputdevice.registerKey('MediaFastForward');
        tizen.tvinputdevice.registerKey('MediaPlayPause');

        document.querySelectorAll('audio, video').forEach(attachMediaListeners);
        observer.observe(document.body, { childList: true, subtree: true });

        createBypassVideo();
        createOverlay();
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
