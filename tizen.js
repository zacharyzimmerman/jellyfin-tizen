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

    // Screensaver bypass: play a real H.264 MP4 on a hidden <video> element.
    // Samsung OLED TVs suppress the 2-minute screensaver only when they
    // detect active video DECODING at the OS/media-pipeline level (confirmed
    // by Spotify community: music videos don't trigger screensaver, audio-
    // only does). A real H.264 file goes through the hardware decoder,
    // which is what Samsung's firmware monitors — unlike captureStream()
    // which may only create a software-level MediaStream.
    var dummyVideo = null;

    // Minimal valid H.264/MP4 (~1 kB) — single black frame, enough to
    // engage the hardware decoder when looped.
    var DUMMY_MP4 = 'data:video/mp4;base64,' +
        'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAAIZnJlZQAAAr9tZGF0AAAC' +
        'oAYF//+c3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDEyNSAtIEguMjY0L01QRUct' +
        'NCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMTIgLSBodHRwOi8vd3d3LnZpZGVv' +
        'bGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9' +
        'MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3Jk' +
        'PTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVs' +
        'bGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNo' +
        'cm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz02IGxvb2thaGVhZF90aHJlYWRzPTEgc2xp' +
        'Y2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9j' +
        'b21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBi' +
        'X2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2Vp' +
        'Z2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNCBzY2VuZWN1dD00MCBpbnRyYV9y' +
        'ZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBx' +
        'Y29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBh' +
        'cT0xOjEuMDAAgAAAAA9liIQAV/0TAAYdeBTXzg8AAALvbW9vdgAAAGxtdmhkAAAAAAAA' +
        'AAAAAAAAAAAAD6AAAACoAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAA' +
        'AAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAhl0cmFrAAAAXHRr' +
        'aGQAAAAPAAAAAAAAAAAAAAABAAAAAAAAACoAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA' +
        'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAgAAAAIAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAA' +
        'AAEAAAAqAAAAAAABAAAAAAGRbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAAgBVxAAA' +
        'AAAALHB2bHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABPG1pbmYA' +
        'AAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA' +
        'AQAAAPxzdGJsAAAAmHN0c2QAAAAAAAAAAQAAAIhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAA' +
        'AAAACAAIAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY' +
        '//8AAAAyYXZjQwFkAAr/4QAZZGQACqzZX5ZcBbIAAAMAAgAAAwBgHiRLLAEABmjr48si' +
        'wAAAABhzdHRzAAAAAAAAAAEAAAABAAACAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAAB' +
        'AAAAFHNOc3oAAAAAAAACtwAAAAEAAAAUc3RjbwAAAAAAAAABAAAAMAAAAGJ1ZHRhAAAAWm1l' +
        'dGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRv' +
        'bwAAAB1kYXRhAAAAAQAAAABMYXZmNTQuNjMuMTA0';

    function createDummyVideo() {
        if (dummyVideo) return;

        dummyVideo = document.createElement('video');
        dummyVideo.src = DUMMY_MP4;
        dummyVideo.muted = true;
        dummyVideo.loop = true;
        dummyVideo.setAttribute('playsinline', '');
        dummyVideo._tizenScreenSaver = true; // skip in MutationObserver
        // Full-screen but invisible: the firmware likely checks that a
        // playing video element has a meaningful layout size. Use full
        // viewport dimensions behind all content so it passes any size
        // check while remaining invisible to the user.
        dummyVideo.style.cssText =
            'position:fixed;top:0;left:0;width:100%;height:100%;' +
            'opacity:0.001;pointer-events:none;z-index:-9999;';
        document.body.appendChild(dummyVideo);

        dummyVideo.play().then(function () {
            postMessage('dummyVideo', 'playing H.264 MP4 — hardware decoder engaged');
        }).catch(function (err) {
            postMessage('dummyVideo', { error: err.message });
        });
    }

    function removeDummyVideo() {
        if (dummyVideo) {
            dummyVideo.pause();
            dummyVideo.removeAttribute('src');
            dummyVideo.load(); // release decoder resources
            dummyVideo.remove();
            dummyVideo = null;
        }
        postMessage('dummyVideo', 'removed');
    }

    // Screen saver suppression — directly observe media elements
    // NativeShell.updateMediaSession/hideMediaSession are only called when
    // navigator.mediaSession is absent, but modern Tizen browsers have it,
    // so we must listen for playback events independently.
    var screenSaverSuppressed = false;
    var keepAliveTimer = null;

    // Method 4: Simulate user activity by dispatching a synthetic key event
    // every 90 seconds. The OLED screensaver activates after 2 minutes of
    // no user input — a periodic keypress resets that timer. Uses
    // ColorF0Red (F1 color key) which has no side-effects in Jellyfin.
    function startKeepAlive() {
        if (keepAliveTimer) return;
        keepAliveTimer = setInterval(function () {
            var ev = new KeyboardEvent('keydown', {
                key: 'ColorF0Red',
                code: 'ColorF0Red',
                keyCode: 403,
                bubbles: true,
                cancelable: true
            });
            document.dispatchEvent(ev);
            postMessage('keepAlive', 'dispatched synthetic keydown (ColorF0Red)');
        }, 90000); // every 90 seconds
    }

    function stopKeepAlive() {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
            postMessage('keepAlive', 'stopped');
        }
    }

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

        // Method 3: Hidden H.264 MP4 — engages hardware video decoder
        createDummyVideo();

        // Method 4: Periodic synthetic keypress — resets activity timer
        startKeepAlive();

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

        // Method 4: Stop synthetic keypress
        stopKeepAlive();

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
