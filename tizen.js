(function () {
    'use strict';

    console.log('Tizen adapter');

    // On-screen debug overlay — shows log messages directly on the TV
    // Reduced to critical messages only, with larger font for readability on photos
    var _debugOverlay = null;
    var _debugLines = [];
    var _MAX_DEBUG_LINES = 25;
    // Only show messages matching these keywords (keep log concise on TV)
    // Show ALL screensaverBypass messages (no filtering) to see full sequence
    var _DEBUG_FILTER = null; // null = show everything
    function debugLog(msg) {
        var text = typeof msg === 'object' ? JSON.stringify(msg) : String(msg);
        var ts = new Date().toLocaleTimeString('en-US', { hour12: false }).substring(0, 8);
        var line = ts + ' ' + text;
        // Show all messages (debug mode — no filter)
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

    // Screensaver bypass overview:
    //
    // Samsung OLED TVs force a screensaver after 2 min of static pixels. The
    // firmware only suppresses it when the HARDWARE VIDEO DECODER is active.
    // Tizen also has a single media element limitation — only one <audio> or
    // <video> can play at a time.
    //
    // Solution (proxy pattern): intercept document.createElement('audio') and
    // hook the src setter. When jellyfin-web sets an audio URL, we create a
    // HIDDEN <video> element with jMuxer's MSE pipeline (AAC audio + H.264
    // black video frames). The <audio> stays in the DOM as jellyfin-web's API
    // surface — play(), pause(), volume, currentTime, and all events are
    // proxied between the two elements. This way:
    //
    //   1. canPlayType() works correctly (real <audio> for device profile)
    //   2. jellyfin-web's _mediaElement reference stays valid
    //   3. All event listeners (timeupdate, ended, etc.) fire correctly
    //   4. The hidden <video> engages the hardware decoder via MSE
    //   5. If MSE fails, the proxy tears down and <audio> plays natively

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
        debugLog('[DIAG] MediaSource: ' + hasMS);
        console.log('[TIZEN-DIAG] MediaSource available:', hasMS);
        if (hasMS) {
            codecs.forEach(function (c) {
                var supported = MediaSource.isTypeSupported(c);
                debugLog('[DIAG] ' + c + ': ' + supported);
                console.log('[TIZEN-DIAG] isTypeSupported(' + c + '):', supported);
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
        var parts = [];
        for (var a = 0; a < arguments.length; a++) {
            parts.push(typeof arguments[a] === 'object' ? JSON.stringify(arguments[a]) : String(arguments[a]));
        }
        debugLog(parts.join(' '));
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

    // Fall back to native audio playback if MSE fails on the TV.
    // With the proxy pattern, we just tear down the proxy and set the original
    // URL natively on the <audio> element that jellyfin-web still holds.
    function fallbackToNative(videoEl, originalUrl) {
        postMessage('screensaverBypass', 'MSE runtime error — falling back to native audio playback');

        // Find the <audio> element that owns this proxy
        var audioEl = videoEl._proxyOwner;
        if (audioEl) {
            tearDownProxy(audioEl);
            nativeSrcDesc.set.call(audioEl, originalUrl);
            postMessage('screensaverBypass', 'restored native playback on <audio>');
        } else {
            // Shouldn't happen, but try to play on the video element directly
            stopMSEPlayback();
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

    // Override document.createElement: hook <audio> to proxy playback through
    // a hidden <video> with MSE, keeping the <audio> as jellyfin-web's API surface.
    //
    // Architecture:
    //   jellyfin-web  ←→  <audio> (proxy)  ←→  <video> (hidden, MSE pipeline)
    //
    // The <audio> stays in the DOM and keeps all jellyfin-web's event listeners.
    // play(), pause(), volume, currentTime are proxied to the <video>.
    // Events from <video> are re-dispatched on <audio> so jellyfin-web sees them.
    // If MSE fails, the proxy is torn down and <audio> plays natively.

    var _origCreateElement = document.createElement.bind(document);
    // Track the currently proxied pair for cleanup
    var _proxyVideoEl = null;
    var _audioCount = 0;

    document.createElement = function (tagName) {
        if (tagName && tagName.toLowerCase() === 'audio') {
            var el = _origCreateElement('audio');
            el._tizenHooked = true;
            el._tizenId = ++_audioCount;

            postMessage('screensaverBypass', 'AUDIO #' + el._tizenId + ' created');

            Object.defineProperty(el, 'src', {
                get: function () {
                    return el._tizenProxiedSrc || nativeSrcDesc.get.call(el);
                },
                set: function (url) {
                    postMessage('screensaverBypass', '#' + el._tizenId + ' srcSet=' + (url ? url.substring(0, 80) : String(url)));

                    // BLOCK src="" or src=null while proxy is active — jellyfin-web
                    // does this as "cleanup" before/after playback, but it kills our
                    // MSE proxy. Just swallow it and keep the proxy running.
                    if (el._tizenProxy && (!url || url === '')) {
                        try {
                            throw new Error('src-clear-trace');
                        } catch (traceErr) {
                            var frames = traceErr.stack.split('\n').slice(1, 6);
                            postMessage('screensaverBypass', 'BLOCKED src=""');
                            frames.forEach(function (f) {
                                postMessage('screensaverBypass', '  ' + f.trim());
                            });
                        }
                        return; // swallow — don't tear down
                    }

                    // Log who is setting src when proxy is active (debug)
                    if (el._tizenProxy && !/\/Audio\//i.test(url)) {
                        try {
                            throw new Error('src-change-trace');
                        } catch (traceErr) {
                            var frames2 = traceErr.stack.split('\n').slice(1, 6);
                            postMessage('screensaverBypass', 'TEARDOWN BY non-audio src:');
                            frames2.forEach(function (f) {
                                postMessage('screensaverBypass', '  ' + f.trim());
                            });
                        }
                    }

                    // Tear down any existing proxy
                    tearDownProxy(el);

                    if (url && /\/Audio\//i.test(url)) {
                        postMessage('screensaverBypass', 'audio URL detected — attempting MSE proxy');

                        var videoEl = _origCreateElement('video');
                        videoEl.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0.01;pointer-events:none;z-index:-1;';
                        videoEl.setAttribute('playsinline', '');

                        // Append hidden <video> to body FIRST — MSE needs it in DOM
                        document.body.appendChild(videoEl);

                        var started = startMSEPlayback(videoEl, url);
                        if (started) {
                            postMessage('screensaverBypass', 'MSE started — setting up proxy');
                            setupProxy(el, videoEl, url);
                            return;
                        }
                        // MSE failed — remove the unused <video>
                        document.body.removeChild(videoEl);
                        postMessage('screensaverBypass', 'MSE failed — using native <audio> playback');
                    }

                    // Default: set src on the <audio> natively
                    nativeSrcDesc.set.call(el, url);
                },
                configurable: true,
                enumerable: true
            });

            // Also intercept setAttribute('src', ...) — some code paths use this
            var _origSetAttribute = el.setAttribute.bind(el);
            el.setAttribute = function (name, value) {
                if (name === 'src') {
                    el.src = value;
                    return;
                }
                return _origSetAttribute(name, value);
            };

            // Intercept removeAttribute('src') — another way to clear source
            var _origRemoveAttribute = el.removeAttribute.bind(el);
            el.removeAttribute = function (name) {
                if (name === 'src') {
                    el.src = '';
                    return;
                }
                return _origRemoveAttribute(name);
            };

            return el;
        }
        return _origCreateElement.apply(document, arguments);
    };

    // Events to forward from <video> → <audio> so jellyfin-web's listeners fire.
    // NOTE: 'error' is intentionally excluded — forwarding video errors would
    // trigger jellyfin-web's onError handler which destroys the player. MSE
    // errors are handled internally by fallbackToNative() instead.
    var PROXY_EVENTS = ['playing', 'play', 'pause', 'ended', 'waiting',
                        'timeupdate', 'volumechange', 'durationchange', 'canplay',
                        'loadeddata', 'loadedmetadata', 'seeked', 'seeking'];

    function setupProxy(audioEl, videoEl, originalUrl) {
        audioEl._tizenProxy = {
            videoEl: videoEl,
            originalUrl: originalUrl,
            eventForwarders: {},
            autoplayPending: false
        };
        videoEl._proxyOwner = audioEl;
        _proxyVideoEl = videoEl;

        // Forward events from <video> to <audio>
        PROXY_EVENTS.forEach(function (evtName) {
            var forwarder = function (e) {
                // Create and dispatch a matching event on the <audio>
                try {
                    var synth = new Event(evtName, { bubbles: e.bubbles, cancelable: e.cancelable });
                    audioEl.dispatchEvent(synth);
                } catch (err) {
                    postMessage('screensaverBypass', { eventForwardError: evtName, err: err.message });
                }
            };
            audioEl._tizenProxy.eventForwarders[evtName] = forwarder;
            videoEl.addEventListener(evtName, forwarder);
        });

        // Store the URL so the getter returns it
        audioEl._tizenProxiedSrc = originalUrl;

        // Override play() — return a resolved promise immediately so jellyfin-web
        // doesn't think playback failed. The actual video.play() happens when
        // jMuxer's onReady fires and data is buffered.
        audioEl._origPlay = audioEl.play;
        audioEl.play = function () {
            postMessage('screensaverBypass', 'proxied play() — returning resolved promise');
            if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                var vid = audioEl._tizenProxy.videoEl;
                // If video already has data, play it now; otherwise defer
                if (vid.readyState >= 2) {
                    postMessage('screensaverBypass', 'video ready — playing now');
                    vid.play().catch(function (e) {
                        postMessage('screensaverBypass', { videoPlayError: e.message });
                    });
                } else {
                    postMessage('screensaverBypass', 'video not ready — deferring play to canplay');
                    audioEl._tizenProxy.autoplayPending = true;
                    vid.addEventListener('canplay', function onCanPlay() {
                        vid.removeEventListener('canplay', onCanPlay);
                        if (audioEl._tizenProxy) {
                            postMessage('screensaverBypass', 'canplay fired — starting video playback');
                            vid.play().catch(function (e) {
                                postMessage('screensaverBypass', { deferredPlayError: e.message });
                            });
                        }
                    });
                }
                // Return resolved promise to jellyfin-web so it doesn't error out
                return Promise.resolve();
            }
            return audioEl._origPlay.call(audioEl);
        };

        // Override pause() to delegate to the <video>
        audioEl._origPause = audioEl.pause;
        audioEl.pause = function () {
            postMessage('screensaverBypass', 'proxied pause() → <video>');
            if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                audioEl._tizenProxy.videoEl.pause();
                return;
            }
            audioEl._origPause.call(audioEl);
        };

        // Proxy volume — jellyfin-web reads and writes .volume
        var nativeVolumeDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
        Object.defineProperty(audioEl, 'volume', {
            get: function () {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    return nativeVolumeDesc.get.call(audioEl._tizenProxy.videoEl);
                }
                return nativeVolumeDesc.get.call(audioEl);
            },
            set: function (v) {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    nativeVolumeDesc.set.call(audioEl._tizenProxy.videoEl, v);
                }
                nativeVolumeDesc.set.call(audioEl, v);
            },
            configurable: true,
            enumerable: true
        });

        // Proxy muted
        var nativeMutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'muted');
        Object.defineProperty(audioEl, 'muted', {
            get: function () {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    return nativeMutedDesc.get.call(audioEl._tizenProxy.videoEl);
                }
                return nativeMutedDesc.get.call(audioEl);
            },
            set: function (v) {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    nativeMutedDesc.set.call(audioEl._tizenProxy.videoEl, v);
                }
                nativeMutedDesc.set.call(audioEl, v);
            },
            configurable: true,
            enumerable: true
        });

        // Proxy currentTime — jellyfin-web reads this for progress bar
        var nativeCTDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
        Object.defineProperty(audioEl, 'currentTime', {
            get: function () {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    return nativeCTDesc.get.call(audioEl._tizenProxy.videoEl);
                }
                return nativeCTDesc.get.call(audioEl);
            },
            set: function (v) {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    nativeCTDesc.set.call(audioEl._tizenProxy.videoEl, v);
                }
                nativeCTDesc.set.call(audioEl, v);
            },
            configurable: true,
            enumerable: true
        });

        // Proxy duration (read-only)
        var nativeDurDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration');
        Object.defineProperty(audioEl, 'duration', {
            get: function () {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    return nativeDurDesc.get.call(audioEl._tizenProxy.videoEl);
                }
                return nativeDurDesc.get.call(audioEl);
            },
            configurable: true,
            enumerable: true
        });

        // Proxy paused (read-only)
        var nativePausedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'paused');
        Object.defineProperty(audioEl, 'paused', {
            get: function () {
                if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                    return nativePausedDesc.get.call(audioEl._tizenProxy.videoEl);
                }
                return nativePausedDesc.get.call(audioEl);
            },
            configurable: true,
            enumerable: true
        });

        // Proxy ended (read-only)
        var nativeEndedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'ended');
        if (nativeEndedDesc) {
            Object.defineProperty(audioEl, 'ended', {
                get: function () {
                    if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                        return nativeEndedDesc.get.call(audioEl._tizenProxy.videoEl);
                    }
                    return nativeEndedDesc.get.call(audioEl);
                },
                configurable: true,
                enumerable: true
            });
        }

        // Proxy buffered (read-only, TimeRanges)
        var nativeBufferedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'buffered');
        if (nativeBufferedDesc) {
            Object.defineProperty(audioEl, 'buffered', {
                get: function () {
                    if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                        return nativeBufferedDesc.get.call(audioEl._tizenProxy.videoEl);
                    }
                    return nativeBufferedDesc.get.call(audioEl);
                },
                configurable: true,
                enumerable: true
            });
        }

        // Proxy readyState (read-only) — jellyfin-web checks this
        var nativeReadyDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'readyState');
        if (nativeReadyDesc) {
            Object.defineProperty(audioEl, 'readyState', {
                get: function () {
                    if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                        return nativeReadyDesc.get.call(audioEl._tizenProxy.videoEl);
                    }
                    return nativeReadyDesc.get.call(audioEl);
                },
                configurable: true,
                enumerable: true
            });
        }

        // Proxy networkState (read-only)
        var nativeNetDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'networkState');
        if (nativeNetDesc) {
            Object.defineProperty(audioEl, 'networkState', {
                get: function () {
                    if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                        return nativeNetDesc.get.call(audioEl._tizenProxy.videoEl);
                    }
                    return nativeNetDesc.get.call(audioEl);
                },
                configurable: true,
                enumerable: true
            });
        }

        // Proxy error (read-only)
        var nativeErrorDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'error');
        if (nativeErrorDesc) {
            Object.defineProperty(audioEl, 'error', {
                get: function () {
                    if (audioEl._tizenProxy && audioEl._tizenProxy.videoEl) {
                        return nativeErrorDesc.get.call(audioEl._tizenProxy.videoEl);
                    }
                    return nativeErrorDesc.get.call(audioEl);
                },
                configurable: true,
                enumerable: true
            });
        }

        // Handle autoplay: jellyfin-web sets elem.autoplay = true then calls play()
        audioEl.autoplay = false; // prevent <audio> from trying to autoplay nothing

        postMessage('screensaverBypass', 'proxy fully configured');
    }

    function tearDownProxy(audioEl) {
        if (!audioEl._tizenProxy) return;

        postMessage('screensaverBypass', 'tearing down proxy');
        var proxy = audioEl._tizenProxy;

        // Stop MSE pipeline
        stopMSEPlayback();

        // Remove event forwarders
        PROXY_EVENTS.forEach(function (evtName) {
            if (proxy.eventForwarders[evtName]) {
                proxy.videoEl.removeEventListener(evtName, proxy.eventForwarders[evtName]);
            }
        });

        // Remove hidden <video> from DOM
        if (proxy.videoEl.parentNode) {
            proxy.videoEl.parentNode.removeChild(proxy.videoEl);
        }

        // Restore play/pause
        if (audioEl._origPlay) { audioEl.play = audioEl._origPlay; delete audioEl._origPlay; }
        if (audioEl._origPause) { audioEl.pause = audioEl._origPause; delete audioEl._origPause; }

        // Clear proxy state
        delete audioEl._tizenProxiedSrc;
        delete audioEl._tizenProxy;
        _proxyVideoEl = null;
    }

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

    // Ensure server address is pre-filled and auto-authenticate test account
    var SERVER_URL = 'https://movies.great-tags.com';
    var SERVER_NAME = 'Jellyfin';

    (function preFillAndAuth() {
        var creds = localStorage.getItem('jellyfin_credentials');
        var data = null;
        try { data = creds ? JSON.parse(creds) : null; } catch (e) { /* ignore */ }
        if (!data) data = { Servers: [] };
        if (!data.Servers) data.Servers = [];

        // Find or create our server entry
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

        // Save server entry (no auto-auth — user logs in manually)
        localStorage.setItem('jellyfin_credentials', JSON.stringify(data));
        postMessage('serverPreFill', 'server entry saved (manual login)');
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
