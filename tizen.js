(function () {
    'use strict';

    console.log('Tizen adapter');

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

    function postMessage() {
        console.log.apply(console, arguments);
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

                // Re-enable the screen saver before exiting
                try {
                    webapis.appcommon.setScreenSaver(
                        webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON
                    );
                } catch (e) {
                    // Ignore errors during exit
                }
                try {
                    tizen.power.release('SCREEN');
                } catch (e) {
                    // Ignore errors during exit
                }

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

            // Suppress the Samsung screen saver during active playback
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

            // Re-enable the Samsung screen saver when playback stops
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

    // Screensaver bypass: play a real video from the Jellyfin server in a
    // visible mini-player during audio playback. Samsung OLED firmware only
    // suppresses the 2-min screensaver when it detects real video playback
    // through the standard media pipeline — data URIs, hidden elements, and
    // API calls all failed. A visible muted video is the nuclear option that
    // we know works because Jellyfin's own video playback suppresses it.
    var pipVideo = null;
    var pipContainer = null;

    function getJellyfinCredentials() {
        // jellyfin-web stores auth in the 'jellyfin_credentials' key
        try {
            var creds = JSON.parse(localStorage.getItem('jellyfin_credentials'));
            if (creds && creds.Servers && creds.Servers.length > 0) {
                var server = creds.Servers[0];
                return {
                    serverUrl: server.ManualAddress || server.LocalAddress || server.RemoteAddress,
                    token: server.AccessToken,
                    userId: server.UserId
                };
            }
        } catch (e) {
            postMessage('pipVideo', { error: 'Failed to read credentials: ' + e.message });
        }
        return null;
    }

    function fetchRandomVideoUrl(creds) {
        // Ask Jellyfin for a random video item with actual media files
        // LocationTypes=FileSystem excludes virtual/placeholder entries
        var url = creds.serverUrl + '/Items?MediaTypes=Video&IncludeItemTypes=Movie,Episode' +
            '&Recursive=true&SortBy=Random&Limit=1&LocationTypes=FileSystem&UserId=' + creds.userId;
        postMessage('pipVideo', { fetchUrl: url });
        return fetch(url, {
            headers: { 'X-Emby-Token': creds.token }
        })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            postMessage('pipVideo', { itemCount: data.Items ? data.Items.length : 0 });
            if (data.Items && data.Items.length > 0) {
                var item = data.Items[0];
                // Use transcoding endpoint to guarantee MP4/H264 output
                // regardless of source container (mkv, avi, mov, etc.)
                // Low bitrate since this is just a tiny PiP for screensaver prevention
                var streamUrl = creds.serverUrl + '/Videos/' + item.Id +
                    '/stream.mp4?mediaSourceId=' + item.Id +
                    '&VideoCodec=h264&AudioCodec=aac' +
                    '&MaxVideoBitRate=500000&MaxWidth=320&MaxHeight=180' +
                    '&api_key=' + creds.token;
                postMessage('pipVideo', { itemName: item.Name, itemId: item.Id, streamUrl: streamUrl });
                return streamUrl;
            }
            return null;
        });
    }

    function createPipVideo() {
        if (pipVideo) return;

        var creds = getJellyfinCredentials();
        if (!creds) {
            postMessage('pipVideo', 'no credentials found — cannot create PiP');
            return;
        }

        fetchRandomVideoUrl(creds).then(function (streamUrl) {
            if (!streamUrl) {
                postMessage('pipVideo', 'no video items found on server');
                return;
            }

            // Container with rounded corners and subtle border
            pipContainer = document.createElement('div');
            pipContainer.id = 'tizen-pip-screensaver';
            pipContainer.style.cssText =
                'position:fixed;bottom:20px;right:20px;width:192px;height:108px;' +
                'border-radius:8px;overflow:hidden;z-index:999998;' +
                'box-shadow:0 2px 8px rgba(0,0,0,0.6);border:1px solid rgba(255,255,255,0.1);';
            document.body.appendChild(pipContainer);

            pipVideo = document.createElement('video');
            pipVideo.src = streamUrl;
            pipVideo.muted = true;
            pipVideo.loop = true;
            pipVideo.setAttribute('playsinline', '');
            pipVideo._tizenScreenSaver = true; // skip in MutationObserver
            pipVideo.style.cssText = 'width:100%;height:100%;object-fit:cover;';
            pipVideo.addEventListener('error', function () {
                var e = pipVideo.error;
                postMessage('pipVideo', { videoError: e ? e.code + ': ' + e.message : 'unknown' });
            });
            pipVideo.addEventListener('loadeddata', function () {
                postMessage('pipVideo', 'loadeddata — video frames ready');
            });
            pipContainer.appendChild(pipVideo);

            pipVideo.play().then(function () {
                postMessage('pipVideo', 'playing — screensaver should be suppressed');
            }).catch(function (err) {
                postMessage('pipVideo', { error: err.message });
            });
        }).catch(function (err) {
            postMessage('pipVideo', { error: 'fetch failed: ' + err.message });
        });
    }

    function removePipVideo() {
        if (pipVideo) {
            pipVideo.pause();
            pipVideo.removeAttribute('src');
            pipVideo.load();
            pipVideo = null;
        }
        if (pipContainer) {
            pipContainer.remove();
            pipContainer = null;
        }
        postMessage('pipVideo', 'removed');
    }

    // Screen saver suppression — directly observe media elements
    // NativeShell.updateMediaSession/hideMediaSession are only called when
    // navigator.mediaSession is absent, but modern Tizen browsers have it,
    // so we must listen for playback events independently.
    var screenSaverSuppressed = false;

    function suppressScreenSaver() {
        if (screenSaverSuppressed) return;
        postMessage('suppressScreenSaver', 'attempting');

        // Samsung AppCommon API (may not work without Auto Protection Time)
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                function () { postMessage('setScreenSaver', { state: 'OFF' }); },
                function (err) { postMessage('setScreenSaver', { state: 'OFF', error: JSON.stringify(err) }); }
            );
        } catch (e) {
            postMessage('setScreenSaver', { error: e.message });
        }

        // Tizen Power API
        try {
            tizen.power.request('SCREEN', 'SCREEN_NORMAL');
        } catch (e) { /* ignore */ }

        // PiP video — real video from server, visible in bottom-right
        createPipVideo();

        screenSaverSuppressed = true;
    }

    function restoreScreenSaver() {
        if (!screenSaverSuppressed) return;
        postMessage('restoreScreenSaver', 'attempting');

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

        removePipVideo();

        screenSaverSuppressed = false;
    }

    function attachMediaListeners(el) {
        if (el._tizenScreenSaver) return;
        el._tizenScreenSaver = true;
        el.addEventListener('playing', suppressScreenSaver);
        el.addEventListener('pause', restoreScreenSaver);
        el.addEventListener('ended', restoreScreenSaver);
        el.addEventListener('emptied', restoreScreenSaver);
    }

    // Watch for dynamically created audio/video elements
    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (m) {
            m.addedNodes.forEach(function (node) {
                if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
                    attachMediaListeners(node);
                }
                // Also check children (e.g. a container with a media element inside)
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

        // Attach to any media elements already in the DOM
        document.querySelectorAll('audio, video').forEach(attachMediaListeners);

        // Observe for new media elements added later
        observer.observe(document.body, { childList: true, subtree: true });
    });

    function updateKeys() {
        if (location.hash.indexOf('/queue') !== -1 || location.hash.indexOf('/video') !== -1) {
            // Disable on-screen playback control, if available on the page
            tizen.tvinputdevice.registerKey('MediaPlayPause');
        } else {
            tizen.tvinputdevice.unregisterKey('MediaPlayPause');
        }
    }

    window.addEventListener('viewshow', updateKeys);
})();
