(function () {
    'use strict';

    console.log('Tizen adapter');

    function debugLog(msg) {
        var text = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
        console.log('[TIZEN] ' + text);
    }

    function postMessage() {
        var parts = [];
        for (var a = 0; a < arguments.length; a++) {
            parts.push(typeof arguments[a] === 'object' ? JSON.stringify(arguments[a]) : String(arguments[a]));
        }
        console.log('[TIZEN] ' + parts.join(' '));
    }

    // ============================================================
    // HLS.js Buffer Override
    // ============================================================
    //
    // jellyfin-web 10.10.z ships with maxMaxBufferLength=6s which
    // causes audio sticking/jumping on slow networks. Intercept the
    // Hls constructor and increase buffer limits so the player can
    // build up resilience over time.

    (function patchHlsBuffer() {
        var _RealHls = null;

        function wrapHls(Original) {
            if (Original._tizenPatched) return Original;

            // Also patch DefaultConfig so any codepath reading defaults gets our values
            if (Original.DefaultConfig) {
                Original.DefaultConfig.maxMaxBufferLength = 120;
                Original.DefaultConfig.maxBufferLength = 30;
                Original.DefaultConfig.maxBufferSize = 60 * 1000 * 1000;
            }

            var Patched = function (config) {
                var cfg = config || {};
                // Allow up to 120s of forward buffer (default was capped at 6s)
                if (!cfg.maxMaxBufferLength || cfg.maxMaxBufferLength < 120) {
                    cfg.maxMaxBufferLength = 120;
                }
                // Ensure a healthy minimum buffer target of 30s
                if (!cfg.maxBufferLength || cfg.maxBufferLength < 30) {
                    cfg.maxBufferLength = 30;
                }
                // Allow up to 60MB buffer (default is often 30MB)
                if (!cfg.maxBufferSize || cfg.maxBufferSize < 60 * 1000 * 1000) {
                    cfg.maxBufferSize = 60 * 1000 * 1000;
                }
                debugLog('HLS buffer override: maxMaxBufferLength=' + cfg.maxMaxBufferLength +
                    's, maxBufferLength=' + cfg.maxBufferLength +
                    's, maxBufferSize=' + cfg.maxBufferSize);
                return new Original(cfg);
            };

            // Copy static properties and prototype
            Object.keys(Original).forEach(function (key) {
                try { Patched[key] = Original[key]; } catch (e) {}
            });
            Patched.prototype = Original.prototype;
            Patched._tizenPatched = true;

            return Patched;
        }

        // Intercept Hls assignment on window (webpack bundles set window.Hls)
        Object.defineProperty(window, 'Hls', {
            configurable: true,
            get: function () { return _RealHls; },
            set: function (val) {
                if (val && typeof val === 'function' && !val._tizenPatched) {
                    _RealHls = wrapHls(val);
                    debugLog('HLS.js constructor patched for larger buffers');
                } else {
                    _RealHls = val;
                }
            }
        });
    })();

    // ============================================================
    // OLED Screensaver Bypass
    // ============================================================

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

        showNowPlayingButton();
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
        hideNowPlayingButton();
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
    // Header Button — Album Art View
    // ============================================================
    //
    // Injects an "album" icon button into the skinHeader next to
    // the existing music_note button. Visible during audio playback.
    // Clicking it opens the album art page (fullscreen overlay that
    // fetches current playback from the Jellyfin API).

    var _nowPlayingBtn = null;
    var _headerInjected = false;

    function injectHeaderButton() {
        if (_headerInjected) return;

        var header = document.querySelector('.skinHeader .headerRight');
        if (!header) return;

        var audioBtn = header.querySelector('.headerAudioPlayerButton');

        var btn = document.createElement('button');
        btn.setAttribute('is', 'paper-icon-button-light');
        btn.className = 'headerButton headerButtonRight headerAlbumArtButton hide';
        btn.title = 'Album Art';
        btn.innerHTML = '<span class="material-icons album" aria-hidden="true"></span>';
        btn.addEventListener('click', function () {
            toggleAlbumArtPage();
        });

        if (audioBtn && audioBtn.nextSibling) {
            header.insertBefore(btn, audioBtn.nextSibling);
        } else if (audioBtn) {
            header.appendChild(btn);
        } else {
            header.insertBefore(btn, header.firstChild);
        }

        _nowPlayingBtn = btn;
        _headerInjected = true;
        debugLog('album art button injected into header');

        if (_bypassActive) {
            btn.classList.remove('hide');
        }
    }

    function showNowPlayingButton() {
        if (_nowPlayingBtn) _nowPlayingBtn.classList.remove('hide');
    }

    function hideNowPlayingButton() {
        if (_nowPlayingBtn) _nowPlayingBtn.classList.add('hide');
    }

    function watchForHeader() {
        injectHeaderButton();
        if (_headerInjected) return;

        var attempts = 0;
        var timer = setInterval(function () {
            attempts++;
            injectHeaderButton();
            if (_headerInjected || attempts >= 30) clearInterval(timer);
        }, 500);

        var headerObserver = new MutationObserver(function () {
            if (!_headerInjected) {
                injectHeaderButton();
            } else {
                var existing = document.querySelector('.headerAlbumArtButton');
                if (!existing) {
                    _headerInjected = false;
                    _nowPlayingBtn = null;
                    injectHeaderButton();
                }
            }
        });
        headerObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ============================================================
    // Album Art Page
    // ============================================================
    //
    // Fullscreen page showing large album art, blurred background,
    // track info, progress bar, and transport controls. Fetches
    // playback state directly from the Jellyfin API so it works
    // regardless of whether updateMediaSession is called.

    var _artPage = null;
    var _artPageVisible = false;
    var _artPageInterval = null;
    var _artPageStyle = null;

    function getApiCredentials() {
        try {
            var creds = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}');
            var servers = creds.Servers || [];
            for (var i = 0; i < servers.length; i++) {
                var s = servers[i];
                if (s.AccessToken && s.UserId) {
                    var url = s.ManualAddress || s.LocalAddress || s.RemoteAddress;
                    return { serverUrl: url, userId: s.UserId, token: s.AccessToken };
                }
            }
        } catch (e) {}
        return null;
    }

    function fetchNowPlaying(creds, callback) {
        var url = creds.serverUrl + '/Sessions?api_key=' + creds.token;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.onload = function () {
            if (xhr.status !== 200) return callback(null);
            try {
                var sessions = JSON.parse(xhr.responseText);
                for (var i = 0; i < sessions.length; i++) {
                    var s = sessions[i];
                    if (s.UserId === creds.userId && s.NowPlayingItem) {
                        callback({
                            item: s.NowPlayingItem,
                            playState: s.PlayState || {},
                            serverUrl: creds.serverUrl,
                            token: creds.token
                        });
                        return;
                    }
                }
                callback(null);
            } catch (e) { callback(null); }
        };
        xhr.onerror = function () { callback(null); };
        xhr.send();
    }

    function getImageUrl(item, serverUrl, maxHeight) {
        var h = maxHeight || 600;
        // Primary image (album art)
        if (item.ImageTags && item.ImageTags.Primary) {
            return serverUrl + '/Items/' + item.Id + '/Images/Primary?maxHeight=' + h + '&tag=' + item.ImageTags.Primary + '&quality=96';
        }
        // Parent (album) image
        if (item.AlbumId && item.AlbumPrimaryImageTag) {
            return serverUrl + '/Items/' + item.AlbumId + '/Images/Primary?maxHeight=' + h + '&tag=' + item.AlbumPrimaryImageTag + '&quality=96';
        }
        return '';
    }

    function formatTicks(ticks) {
        if (!ticks || ticks <= 0) return '0:00';
        var totalSec = Math.floor(ticks / 10000000);
        var min = Math.floor(totalSec / 60);
        var sec = totalSec % 60;
        return min + ':' + (sec < 10 ? '0' : '') + sec;
    }

    function ensureArtPageDOM() {
        if (_artPage) return;

        _artPageStyle = document.createElement('style');
        _artPageStyle.textContent =
            '#tizen-art-page{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;display:none;background:#000}' +
            '#tizen-art-page.visible{display:flex}' +
            '.tap-bg{position:absolute;top:0;left:0;width:100%;height:100%;background-size:cover;background-position:center;filter:blur(50px) brightness(0.25) saturate(1.2);transform:scale(1.3)}' +
            '.tap-content{position:relative;z-index:1;width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:60px;box-sizing:border-box}' +
            '.tap-art-wrap{width:480px;height:480px;border-radius:12px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.7);margin-bottom:40px;background:#1a1a1a;display:flex;align-items:center;justify-content:center}' +
            '.tap-art{width:100%;height:100%;object-fit:cover;display:block}' +
            '.tap-no-art{color:rgba(255,255,255,0.2);font-size:120px}' +
            '.tap-info{text-align:center;margin-bottom:32px;max-width:700px;width:100%}' +
            '.tap-title{font-size:32px;font-weight:600;color:#fff;margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
            '.tap-artist{font-size:22px;color:rgba(255,255,255,0.75);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
            '.tap-album{font-size:17px;color:rgba(255,255,255,0.45);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
            '.tap-progress{display:flex;align-items:center;width:560px;max-width:85vw;margin-bottom:32px}' +
            '.tap-time{font-size:14px;color:rgba(255,255,255,0.5);min-width:48px;font-variant-numeric:tabular-nums}' +
            '.tap-time-cur{text-align:right;margin-right:14px}' +
            '.tap-time-tot{text-align:left;margin-left:14px}' +
            '.tap-bar{flex:1;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden}' +
            '.tap-bar-fill{height:100%;background:#00a4dc;border-radius:2px;width:0%;transition:width 1s linear}' +
            // Transport controls — match jellyfin-web button style for D-pad nav
            '.tap-controls{display:flex;align-items:center;justify-content:center;gap:12px}' +
            '.tap-controls button{background:none;border:none;padding:8px;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent}' +
            '.tap-controls button .material-icons{font-size:42px;color:rgba(255,255,255,0.7)}' +
            '.tap-controls button.tap-play-btn .material-icons{font-size:56px}' +
            '.tap-controls button:focus .material-icons,.tap-controls button:hover .material-icons{color:#00a4dc}';
        document.head.appendChild(_artPageStyle);

        _artPage = document.createElement('div');
        _artPage.id = 'tizen-art-page';
        _artPage.innerHTML =
            '<div class="tap-bg"></div>' +
            '<div class="tap-content">' +
                '<div class="tap-art-wrap"><img class="tap-art" src="" alt=""><span class="tap-no-art" style="display:none">&#x266B;</span></div>' +
                '<div class="tap-info">' +
                    '<div class="tap-title"></div>' +
                    '<div class="tap-artist"></div>' +
                    '<div class="tap-album"></div>' +
                '</div>' +
                '<div class="tap-progress">' +
                    '<div class="tap-time tap-time-cur">0:00</div>' +
                    '<div class="tap-bar"><div class="tap-bar-fill"></div></div>' +
                    '<div class="tap-time tap-time-tot">0:00</div>' +
                '</div>' +
                '<div class="tap-controls focuscontainer-x">' +
                    '<button is="paper-icon-button-light" class="autoSize" data-action="prev" title="Previous Track">' +
                        '<span class="material-icons skip_previous" aria-hidden="true"></span>' +
                    '</button>' +
                    '<button is="paper-icon-button-light" class="tap-play-btn autoSize" data-action="playpause" title="Play/Pause">' +
                        '<span class="material-icons pause_circle_filled" aria-hidden="true"></span>' +
                    '</button>' +
                    '<button is="paper-icon-button-light" class="autoSize" data-action="next" title="Next Track">' +
                        '<span class="material-icons skip_next" aria-hidden="true"></span>' +
                    '</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(_artPage);

        // Transport control clicks — delegate from container
        _artPage.querySelector('.tap-controls').addEventListener('click', function (e) {
            var btn = e.target.closest('button[data-action]');
            if (!btn) return;
            execTransport(btn.getAttribute('data-action'));
        });
    }

    function updateArtPage(data) {
        if (!_artPage) return;

        var item = data.item;
        var playState = data.playState;
        var imgUrl = getImageUrl(item, data.serverUrl, 600);

        var art = _artPage.querySelector('.tap-art');
        var noArt = _artPage.querySelector('.tap-no-art');
        var bg = _artPage.querySelector('.tap-bg');

        if (imgUrl) {
            art.src = imgUrl;
            art.style.display = 'block';
            noArt.style.display = 'none';
            bg.style.backgroundImage = 'url(' + imgUrl + ')';
        } else {
            art.style.display = 'none';
            noArt.style.display = 'block';
            bg.style.backgroundImage = 'none';
        }

        _artPage.querySelector('.tap-title').textContent = item.Name || '';
        _artPage.querySelector('.tap-artist').textContent = item.Artists ? item.Artists.join(', ') : (item.AlbumArtist || '');
        _artPage.querySelector('.tap-album').textContent = item.Album || '';

        var duration = item.RunTimeTicks || 0;
        var position = playState.PositionTicks || 0;
        var pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

        _artPage.querySelector('.tap-time-cur').textContent = formatTicks(position);
        _artPage.querySelector('.tap-time-tot').textContent = formatTicks(duration);
        _artPage.querySelector('.tap-bar-fill').style.width = pct + '%';

        var playIcon = _artPage.querySelector('.tap-play-btn .material-icons');
        if (playIcon) {
            playIcon.className = 'material-icons ' + (playState.IsPaused ? 'play_circle_filled' : 'pause_circle_filled');
        }
    }

    function refreshArtPage() {
        var creds = getApiCredentials();
        if (!creds) return;

        fetchNowPlaying(creds, function (data) {
            if (data) {
                updateArtPage(data);
            }
        });
    }

    function showArtPage() {
        ensureArtPageDOM();
        _artPage.classList.add('visible');
        _artPageVisible = true;

        // Focus play button so D-pad navigation starts there
        var playBtn = _artPage.querySelector('.tap-play-btn');
        if (playBtn) playBtn.focus();

        // Fetch immediately and then poll every 2s
        refreshArtPage();
        if (!_artPageInterval) {
            _artPageInterval = setInterval(refreshArtPage, 2000);
        }
    }

    function hideArtPage() {
        if (_artPage) _artPage.classList.remove('visible');
        _artPageVisible = false;

        if (_artPageInterval) {
            clearInterval(_artPageInterval);
            _artPageInterval = null;
        }
    }

    function toggleAlbumArtPage() {
        if (_artPageVisible) {
            hideArtPage();
        } else {
            showArtPage();
        }
    }

    // Transport control helpers
    function execTransport(action) {
        debugLog('transport: ' + action);

        // Try Jellyfin API command first
        var creds = getApiCredentials();
        if (creds) {
            var sessionUrl = creds.serverUrl + '/Sessions?api_key=' + creds.token;
            var xhr = new XMLHttpRequest();
            xhr.open('GET', sessionUrl);
            xhr.onload = function () {
                if (xhr.status !== 200) return fallbackTransport(action);
                try {
                    var sessions = JSON.parse(xhr.responseText);
                    var sessionId = null;
                    for (var i = 0; i < sessions.length; i++) {
                        if (sessions[i].UserId === creds.userId && sessions[i].NowPlayingItem) {
                            sessionId = sessions[i].Id;
                            break;
                        }
                    }
                    if (!sessionId) return fallbackTransport(action);

                    var cmd, cmdUrl;
                    switch (action) {
                        case 'playpause':
                            cmd = 'PlayPause';
                            cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/' + cmd + '?api_key=' + creds.token;
                            break;
                        case 'next':
                            cmd = 'NextTrack';
                            cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/' + cmd + '?api_key=' + creds.token;
                            break;
                        case 'prev':
                            cmd = 'PreviousTrack';
                            cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/' + cmd + '?api_key=' + creds.token;
                            break;
                    }
                    if (cmdUrl) {
                        var cmdXhr = new XMLHttpRequest();
                        cmdXhr.open('POST', cmdUrl);
                        cmdXhr.send();
                        // Refresh display after a short delay
                        setTimeout(refreshArtPage, 500);
                    }
                } catch (e) { fallbackTransport(action); }
            };
            xhr.onerror = function () { fallbackTransport(action); };
            xhr.send();
            return;
        }

        fallbackTransport(action);
    }

    function fallbackTransport(action) {
        // Try Emby global
        try {
            if (window.Emby && window.Emby.PlaybackManager) {
                var pm = window.Emby.PlaybackManager;
                switch (action) {
                    case 'playpause': pm.playPause(); break;
                    case 'next': pm.nextTrack(); break;
                    case 'prev': pm.previousTrack(); break;
                }
                return;
            }
        } catch (e) {}

        // Dispatch media key events
        var keyMap = { 'playpause': 'MediaPlayPause', 'next': 'MediaTrackNext', 'prev': 'MediaTrackPrevious' };
        if (keyMap[action]) {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: keyMap[action], bubbles: true }));
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

    // ============================================================
    // Server Address Pre-Fill
    // ============================================================
    //
    // Pre-fills the #txtServerHost input when the "Add Server" form
    // appears. Does NOT seed jellyfin_credentials — the default URL
    // is working so we only need the input pre-fill for new setups.

    (function preFillServer() {
        function tryFillServerInput() {
            var input = document.querySelector('#txtServerHost');
            if (input && !input.value) {
                input.value = SERVER_URL;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                debugLog('pre-filled server address');
                return true;
            }
            return false;
        }

        var fillObserver = new MutationObserver(function () {
            tryFillServerInput();
        });

        function startFillObserver() {
            if (document.body) {
                fillObserver.observe(document.body, { childList: true, subtree: true });
            } else {
                document.addEventListener('DOMContentLoaded', function () {
                    fillObserver.observe(document.body, { childList: true, subtree: true });
                });
            }
        }
        startFillObserver();

        window.addEventListener('hashchange', function () {
            setTimeout(tryFillServerInput, 200);
            setTimeout(tryFillServerInput, 600);
        });

        tryFillServerInput();
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
                hideArtPage();
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
        },

        hideMediaSession: function () {
            debugLog('hideMediaSession');
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

        // Encourage aggressive buffering for audio elements
        if (isAudioElement(el)) {
            el.preload = 'auto';
        }

        el.addEventListener('playing', function () {
            if (isAudioElement(el)) {
                startBypass();
            } else if (isVideoPlayback(el)) {
                suppressScreenSaver();
                hideArtPage();
            }
        });

        el.addEventListener('pause', function () {
            if (isVideoPlayback(el)) restoreScreenSaver();
        });

        el.addEventListener('ended', function () {
            if (isVideoPlayback(el)) restoreScreenSaver();
        });

        el.addEventListener('emptied', function () {
            if (isAudioElement(el)) {
                stopBypass();
            } else if (isVideoPlayback(el)) {
                restoreScreenSaver();
            }
        });
    }

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
    // Key handling — intercept when art page is visible
    // ============================================================

    document.addEventListener('keydown', function (e) {
        if (!_artPageVisible) return;

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
            case 10233: // MediaRewind
                execTransport('prev');
                e.preventDefault();
                e.stopPropagation();
                break;
            case 10234: // MediaTrackNext
            case 10228: // MediaFastForward
                execTransport('next');
                e.preventDefault();
                e.stopPropagation();
                break;
            case 13: // Enter/OK — let it activate the focused button naturally
                break;
            case 37: // ArrowLeft
            case 39: // ArrowRight
                // Let D-pad left/right navigate between transport buttons naturally
                // but prevent underlying page from scrolling
                e.stopPropagation();
                break;
            case 38: // ArrowUp
            case 40: // ArrowDown
                // Prevent vertical navigation from leaving the art page
                e.preventDefault();
                e.stopPropagation();
                break;
            case 10009: // Back
            case 27: // Escape
                hideArtPage();
                e.preventDefault();
                e.stopPropagation();
                break;
        }
    }, true);

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
        watchForHeader();
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
