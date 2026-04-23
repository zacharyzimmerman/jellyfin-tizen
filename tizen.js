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

    // Screensaver bypass: play an invisible video to make Tizen's media
    // pipeline believe video content is active. Samsung OLED TVs suppress
    // the 2-minute screensaver when the system detects video playback at the
    // OS level. A tiny canvas stream piped to a hidden <video> element
    // registers as real video playback without affecting audio or UI.
    var dummyVideo = null;
    var dummyCanvas = null;
    var dummyAnimFrame = null;

    function createDummyVideo() {
        if (dummyVideo) return;

        // Create a tiny offscreen canvas that changes every frame
        dummyCanvas = document.createElement('canvas');
        dummyCanvas.width = 2;
        dummyCanvas.height = 2;
        var ctx = dummyCanvas.getContext('2d');

        // Animate the canvas so the stream has changing frames
        function tick() {
            ctx.fillStyle = 'rgb(' +
                (Math.random() * 255 | 0) + ',' +
                (Math.random() * 255 | 0) + ',' +
                (Math.random() * 255 | 0) + ')';
            ctx.fillRect(0, 0, 2, 2);
            dummyAnimFrame = requestAnimationFrame(tick);
        }
        tick();

        // Capture the canvas as a video stream (1 fps is enough)
        var stream = dummyCanvas.captureStream(1);

        // Create a hidden video element that plays the stream
        dummyVideo = document.createElement('video');
        dummyVideo.srcObject = stream;
        dummyVideo.muted = true;
        dummyVideo.loop = true;
        dummyVideo.setAttribute('playsinline', '');
        dummyVideo._tizenScreenSaver = true; // skip in MutationObserver
        dummyVideo.style.cssText =
            'position:fixed;top:-1px;left:-1px;width:1px;height:1px;' +
            'opacity:0.01;pointer-events:none;z-index:-1;';
        document.body.appendChild(dummyVideo);

        dummyVideo.play().then(function () {
            postMessage('dummyVideo', 'playing — screensaver should be suppressed');
        }).catch(function (err) {
            postMessage('dummyVideo', { error: err.message });
        });
    }

    function removeDummyVideo() {
        if (dummyAnimFrame) {
            cancelAnimationFrame(dummyAnimFrame);
            dummyAnimFrame = null;
        }
        if (dummyVideo) {
            dummyVideo.pause();
            dummyVideo.srcObject = null;
            dummyVideo.remove();
            dummyVideo = null;
        }
        if (dummyCanvas) {
            dummyCanvas = null;
        }
        postMessage('dummyVideo', 'removed');
    }

    // Screen saver suppression — directly observe media elements
    // NativeShell.updateMediaSession/hideMediaSession are only called when
    // navigator.mediaSession is absent, but modern Tizen browsers have it,
    // so we must listen for playback events independently.
    var screenSaverSuppressed = false;

    function suppressScreenSaver() {
        if (screenSaverSuppressed) return;
        postMessage('suppressScreenSaver', 'attempting');

        // Method 1: Samsung AppCommon API
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF,
                function () { postMessage('setScreenSaver', { state: 'OFF' }); },
                function (err) { postMessage('setScreenSaver', { state: 'OFF', error: JSON.stringify(err) }); }
            );
        } catch (e) {
            postMessage('setScreenSaver', { error: e.message });
        }

        // Method 2: Tizen Power API — request SCREEN_NORMAL to prevent dimming
        try {
            tizen.power.request('SCREEN', 'SCREEN_NORMAL');
            postMessage('power.request', { state: 'SCREEN_NORMAL' });
        } catch (e) {
            postMessage('power.request', { error: e.message });
        }

        // Method 3: Hidden video stream — Tizen suppresses the screensaver
        // when it detects an active video element in the playing state
        createDummyVideo();

        screenSaverSuppressed = true;
    }

    function restoreScreenSaver() {
        if (!screenSaverSuppressed) return;
        postMessage('restoreScreenSaver', 'attempting');

        // Method 1: Samsung AppCommon API
        try {
            webapis.appcommon.setScreenSaver(
                webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_ON,
                function () { postMessage('setScreenSaver', { state: 'ON' }); },
                function (err) { postMessage('setScreenSaver', { state: 'ON', error: JSON.stringify(err) }); }
            );
        } catch (e) {
            postMessage('setScreenSaver', { error: e.message });
        }

        // Method 2: Release Tizen Power lock
        try {
            tizen.power.release('SCREEN');
            postMessage('power.release', { state: 'SCREEN' });
        } catch (e) {
            postMessage('power.release', { error: e.message });
        }

        // Method 3: Stop dummy video
        removeDummyVideo();

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
