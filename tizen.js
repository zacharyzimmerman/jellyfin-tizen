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
    var _artFocusRow = 'controls'; // 'controls' or 'scrub'
    var _artFocusIdx = 2; // index into control buttons (0-4), default to play (center)
    var _lastDuration = 0;
    var _lastPosition = 0;

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
            // Progress / scrub bar — focusable row
            '.tap-progress{display:flex;align-items:center;width:560px;max-width:85vw;margin-bottom:32px}' +
            '.tap-time{font-size:14px;color:rgba(255,255,255,0.5);min-width:48px;font-variant-numeric:tabular-nums}' +
            '.tap-time-cur{text-align:right;margin-right:14px}' +
            '.tap-time-tot{text-align:left;margin-left:14px}' +
            '.tap-bar{flex:1;height:4px;background:rgba(255,255,255,0.15);border-radius:2px;overflow:hidden;position:relative}' +
            '.tap-bar-fill{height:100%;background:#00a4dc;border-radius:2px;width:0%;transition:width 0.3s linear}' +
            '.tap-scrub-hint{position:absolute;top:-28px;left:50%;transform:translateX(-50%);font-size:13px;color:rgba(255,255,255,0.4);white-space:nowrap;opacity:0;transition:opacity 0.2s}' +
            '.tap-progress.focused .tap-bar{height:8px}' +
            '.tap-progress.focused .tap-bar-fill{transition:width 0.1s linear}' +
            '.tap-progress.focused .tap-scrub-hint{opacity:1}' +
            '.tap-progress.focused .tap-time{color:rgba(255,255,255,0.8)}' +
            // Transport controls — plain buttons with manual focus
            '.tap-controls{display:flex;align-items:center;justify-content:center;gap:16px}' +
            '.tap-controls button{background:none;border:none;padding:8px;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;border-radius:50%}' +
            '.tap-controls button .material-icons{font-size:42px;color:rgba(255,255,255,0.5);transition:color 0.15s,transform 0.15s}' +
            '.tap-controls button.tap-play-btn .material-icons{font-size:56px}' +
            '.tap-controls button.focused .material-icons{color:#00a4dc;transform:scale(1.15)}';
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
                    '<div class="tap-bar"><div class="tap-bar-fill"></div><div class="tap-scrub-hint">&larr; &rarr; to scrub</div></div>' +
                    '<div class="tap-time tap-time-tot">0:00</div>' +
                '</div>' +
                '<div class="tap-controls">' +
                    '<button data-action="prev" data-idx="0" title="Previous Track">' +
                        '<span class="material-icons">skip_previous</span>' +
                    '</button>' +
                    '<button data-action="rw" data-idx="1" title="Rewind 10s">' +
                        '<span class="material-icons">fast_rewind</span>' +
                    '</button>' +
                    '<button class="tap-play-btn" data-action="playpause" data-idx="2" title="Play/Pause">' +
                        '<span class="material-icons">pause_circle_filled</span>' +
                    '</button>' +
                    '<button data-action="ff" data-idx="3" title="Fast Forward 10s">' +
                        '<span class="material-icons">fast_forward</span>' +
                    '</button>' +
                    '<button data-action="next" data-idx="4" title="Next Track">' +
                        '<span class="material-icons">skip_next</span>' +
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

    // Manual focus management for D-pad navigation
    function updateArtFocus() {
        if (!_artPage) return;

        // Clear all focus highlights
        var buttons = _artPage.querySelectorAll('.tap-controls button');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.remove('focused');
        }
        var progress = _artPage.querySelector('.tap-progress');
        progress.classList.remove('focused');

        if (_artFocusRow === 'controls') {
            if (buttons[_artFocusIdx]) {
                buttons[_artFocusIdx].classList.add('focused');
            }
        } else {
            progress.classList.add('focused');
        }
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
        _lastDuration = duration;
        _lastPosition = position;
        var pct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

        _artPage.querySelector('.tap-time-cur').textContent = formatTicks(position);
        _artPage.querySelector('.tap-time-tot').textContent = formatTicks(duration);
        _artPage.querySelector('.tap-bar-fill').style.width = pct + '%';

        var playIcon = _artPage.querySelector('.tap-play-btn .material-icons');
        if (playIcon) {
            playIcon.textContent = playState.IsPaused ? 'play_circle_filled' : 'pause_circle_filled';
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

        // Reset focus to play button
        _artFocusRow = 'controls';
        _artFocusIdx = 2;
        updateArtFocus();

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
    var SEEK_STEP_TICKS = 10 * 10000000; // 10 seconds in ticks
    var SCRUB_STEP_TICKS = 5 * 10000000; // 5 seconds per D-pad press on scrub bar

    function execTransport(action) {
        debugLog('transport: ' + action);

        var creds = getApiCredentials();
        if (!creds) return fallbackTransport(action);

        var sessionUrl = creds.serverUrl + '/Sessions?api_key=' + creds.token;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', sessionUrl);
        xhr.onload = function () {
            if (xhr.status !== 200) return fallbackTransport(action);
            try {
                var sessions = JSON.parse(xhr.responseText);
                var sessionId = null;
                var curPosition = 0;
                for (var i = 0; i < sessions.length; i++) {
                    if (sessions[i].UserId === creds.userId && sessions[i].NowPlayingItem) {
                        sessionId = sessions[i].Id;
                        curPosition = (sessions[i].PlayState || {}).PositionTicks || 0;
                        break;
                    }
                }
                if (!sessionId) return fallbackTransport(action);

                var cmdUrl;
                switch (action) {
                    case 'playpause':
                        cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/PlayPause?api_key=' + creds.token;
                        break;
                    case 'next':
                        cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/NextTrack?api_key=' + creds.token;
                        break;
                    case 'prev':
                        cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/PreviousTrack?api_key=' + creds.token;
                        break;
                    case 'rw':
                        var rwPos = Math.max(0, curPosition - SEEK_STEP_TICKS);
                        cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/Seek?SeekPositionTicks=' + rwPos + '&api_key=' + creds.token;
                        break;
                    case 'ff':
                        var ffPos = curPosition + SEEK_STEP_TICKS;
                        if (_lastDuration > 0) ffPos = Math.min(ffPos, _lastDuration);
                        cmdUrl = creds.serverUrl + '/Sessions/' + sessionId + '/Playing/Seek?SeekPositionTicks=' + ffPos + '&api_key=' + creds.token;
                        break;
                }
                if (cmdUrl) {
                    var cmdXhr = new XMLHttpRequest();
                    cmdXhr.open('POST', cmdUrl);
                    cmdXhr.send();
                    setTimeout(refreshArtPage, 500);
                }
            } catch (e) { fallbackTransport(action); }
        };
        xhr.onerror = function () { fallbackTransport(action); };
        xhr.send();
    }

    function seekToPosition(ticks) {
        var creds = getApiCredentials();
        if (!creds) return;

        var sessionUrl = creds.serverUrl + '/Sessions?api_key=' + creds.token;
        var xhr = new XMLHttpRequest();
        xhr.open('GET', sessionUrl);
        xhr.onload = function () {
            if (xhr.status !== 200) return;
            try {
                var sessions = JSON.parse(xhr.responseText);
                for (var i = 0; i < sessions.length; i++) {
                    if (sessions[i].UserId === creds.userId && sessions[i].NowPlayingItem) {
                        var seekUrl = creds.serverUrl + '/Sessions/' + sessions[i].Id +
                            '/Playing/Seek?SeekPositionTicks=' + ticks + '&api_key=' + creds.token;
                        var sx = new XMLHttpRequest();
                        sx.open('POST', seekUrl);
                        sx.send();
                        setTimeout(refreshArtPage, 500);
                        return;
                    }
                }
            } catch (e) {}
        };
        xhr.send();
    }

    function fallbackTransport(action) {
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

        var handled = true;

        switch (e.keyCode) {
            // --- Media keys ---
            case 415: // MediaPlay
            case 10252: // MediaPlayPause
            case 19: // MediaPause
                execTransport('playpause');
                break;
            case 10232: // MediaTrackPrevious
                execTransport('prev');
                break;
            case 10233: // MediaRewind
                execTransport('rw');
                break;
            case 10234: // MediaTrackNext
                execTransport('next');
                break;
            case 10228: // MediaFastForward
                execTransport('ff');
                break;

            // --- D-pad navigation ---
            case 37: // ArrowLeft
                if (_artFocusRow === 'controls') {
                    _artFocusIdx = Math.max(0, _artFocusIdx - 1);
                    updateArtFocus();
                } else {
                    // Scrub backward 5s
                    var rwPos = Math.max(0, _lastPosition - SCRUB_STEP_TICKS);
                    _lastPosition = rwPos;
                    seekToPosition(rwPos);
                    // Update bar immediately for responsiveness
                    if (_artPage && _lastDuration > 0) {
                        _artPage.querySelector('.tap-bar-fill').style.width = Math.min(100, (rwPos / _lastDuration) * 100) + '%';
                        _artPage.querySelector('.tap-time-cur').textContent = formatTicks(rwPos);
                    }
                }
                break;
            case 39: // ArrowRight
                if (_artFocusRow === 'controls') {
                    _artFocusIdx = Math.min(4, _artFocusIdx + 1);
                    updateArtFocus();
                } else {
                    // Scrub forward 5s
                    var ffPos = _lastPosition + SCRUB_STEP_TICKS;
                    if (_lastDuration > 0) ffPos = Math.min(ffPos, _lastDuration);
                    _lastPosition = ffPos;
                    seekToPosition(ffPos);
                    if (_artPage && _lastDuration > 0) {
                        _artPage.querySelector('.tap-bar-fill').style.width = Math.min(100, (ffPos / _lastDuration) * 100) + '%';
                        _artPage.querySelector('.tap-time-cur').textContent = formatTicks(ffPos);
                    }
                }
                break;
            case 38: // ArrowUp
                if (_artFocusRow === 'scrub') {
                    _artFocusRow = 'controls';
                    updateArtFocus();
                }
                break;
            case 40: // ArrowDown
                if (_artFocusRow === 'controls') {
                    _artFocusRow = 'scrub';
                    updateArtFocus();
                }
                break;

            // --- Enter/OK — activate focused button ---
            case 13:
                if (_artFocusRow === 'controls') {
                    var buttons = _artPage.querySelectorAll('.tap-controls button');
                    if (buttons[_artFocusIdx]) {
                        var action = buttons[_artFocusIdx].getAttribute('data-action');
                        if (action) execTransport(action);
                    }
                }
                break;

            // --- Back/Escape ---
            case 10009: // Back
            case 27: // Escape
                hideArtPage();
                break;

            default:
                handled = false;
                break;
        }

        if (handled) {
            e.preventDefault();
            e.stopPropagation();
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
