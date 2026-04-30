#!/usr/bin/env node
/**
 * Tizen Audio-to-Video MSE Patch
 *
 * Modifies jellyfin-web's htmlAudioPlayer plugin to use a <video> element
 * with MSE (H.264 + AAC) instead of <audio> on Tizen. This engages the
 * hardware video decoder, which suppresses the OLED screensaver.
 *
 * Applied during CI between `npm ci` and `npm run build:production`.
 *
 * What it changes:
 *  1. createMediaElement() → creates <video> instead of <audio> on Tizen
 *  2. setCurrentSrc() native path → uses jMuxer MSE pipeline instead of
 *     native src assignment on Tizen
 *  3. Adds ADTS extraction and H.264 keyframe data inline
 */

const fs = require('fs');
const path = require('path');

const PLUGIN_PATH = path.join(
    process.argv[2] || 'jellyfin-web',
    'src/plugins/htmlAudioPlayer/plugin.js'
);

if (!fs.existsSync(PLUGIN_PATH)) {
    console.error('ERROR: Cannot find ' + PLUGIN_PATH);
    process.exit(1);
}

let src = fs.readFileSync(PLUGIN_PATH, 'utf8');
const original = src;

// ============================================================
// Patch 1: createMediaElement — use <video> on Tizen
// ============================================================

// Find: elem = document.createElement('audio');
// Replace with: elem = document.createElement(browser.tizen ? 'video' : 'audio');
const createAudioOld = "elem = document.createElement('audio');";
const createAudioNew = "console.debug('[TIZEN-MSE] createMediaElement: browser.tizen=' + !!browser.tizen); elem = document.createElement(browser.tizen ? 'video' : 'audio'); console.debug('[TIZEN-MSE] created <' + elem.nodeName + '>');";

if (!src.includes(createAudioOld)) {
    console.error('ERROR: Cannot find createElement(\'audio\') in createMediaElement');
    process.exit(1);
}
src = src.replace(createAudioOld, createAudioNew);
console.log('Patch 1 applied: createMediaElement uses <video> on Tizen');

// ============================================================
// Patch 2: Add MSE helper functions at the top of the file
// ============================================================

// We need to add:
//   - H.264 keyframe data (128x128 black, constrained baseline)
//   - ADTS frame extraction function
//   - jMuxer MSE setup function
//   - A Tizen-specific playback function

const MSE_HELPERS = `
// === TIZEN MSE PATCH START ===
// H.264 128x128 black keyframe (Constrained Baseline, Level 1.3, 1fps)
const TIZEN_H264_BASE64 = 'AAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABBgX//1zcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IHIzMjIzIDA0ODBjYjAgLSBILjI2NC9NUEVHLTQgQVZDIGNvZGVjIC0gQ29weWxlZnQgMjAwMy0yMDI1IC0gaHR0cDovL3d3dy52aWRlb2xhbi5vcmcveDI2NC5odG1sIC0gb3B0aW9uczogY2FiYWM9MCByZWY9MSBkZWJsb2NrPTE6LTM6LTMgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTIuMDA6MC43MCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTQgdGhyZWFkcz00IGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTEga2V5aW50X21pbj0xIHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByYz1jcmYgbWJ0cmVlPTAgY3JmPTUxLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjIwAIAAAAFliIQFc5yYoAAhIybk5OTk5OTrdddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABZYiCAIM5yYoAAk1ycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAAFnQsAN3CBGwEQAAAMABAAAAwAIPFCuAAAAAWjOAZRMgAAAAWWIhAIM5yYoAAk1ycnJycnJyddddddddddddddddddddddddddddddddddddddddddddddddddddddddeAAAAABZ0LADdwgRsBEAAADAAQAAAMACDxQrgAAAAFozgGUTIAAAAFliIIAgznJigACTXJycnJycnJ111111111111111111111111111111111111111111111111111111114AAAAAWdCwA3cIEbARAAAAwAEAAADAAg8UK4AAAABaM4BlEyAAAABZYiEAgznJigACTXJycnJycnJ111111111111111111111111111111111111111111111111111111114A==';

let _tizenH264Keyframe = null;
function getTizenKeyframe() {
    if (_tizenH264Keyframe) return _tizenH264Keyframe;
    const binary = atob(TIZEN_H264_BASE64);
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);

    // Parse NAL units to build SPS+PPS+IDR keyframe
    const nals = [];
    let pos = 0;
    while (pos < data.length - 4) {
        let scLen = 0;
        if (data[pos] === 0 && data[pos+1] === 0 && data[pos+2] === 0 && data[pos+3] === 1) scLen = 4;
        else if (data[pos] === 0 && data[pos+1] === 0 && data[pos+2] === 1) scLen = 3;
        if (scLen > 0) {
            let end = data.length;
            for (let j = pos + scLen; j < data.length - 3; j++) {
                if ((data[j] === 0 && data[j+1] === 0 && data[j+2] === 0 && data[j+3] === 1) ||
                    (data[j] === 0 && data[j+1] === 0 && data[j+2] === 1)) { end = j; break; }
            }
            nals.push({ type: data[pos + scLen] & 0x1F, data: data.slice(pos, end) });
            pos = end;
        } else { pos++; }
    }
    const sps = nals.find(n => n.type === 7);
    const pps = nals.find(n => n.type === 8);
    const idr = nals.find(n => n.type === 5);
    if (!sps || !pps || !idr) return null;
    const kf = new Uint8Array(sps.data.length + pps.data.length + idr.data.length);
    kf.set(sps.data, 0);
    kf.set(pps.data, sps.data.length);
    kf.set(idr.data, sps.data.length + pps.data.length);
    _tizenH264Keyframe = kf;
    return kf;
}

// Extract ADTS frames from raw AAC data
function extractADTSFrames(buffer) {
    const data = new Uint8Array(buffer);
    const frames = [];
    let pos = 0;
    while (pos < data.length - 7) {
        // ADTS sync word: 0xFFF
        if (data[pos] === 0xFF && (data[pos + 1] & 0xF0) === 0xF0) {
            const hasProtection = !(data[pos + 1] & 0x01);
            const frameLen = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | ((data[pos + 5] >> 5) & 0x07);
            if (frameLen > 0 && pos + frameLen <= data.length) {
                frames.push(data.slice(pos, pos + frameLen));
                pos += frameLen;
                continue;
            }
        }
        pos++;
    }
    return frames;
}

// Rewrite audio URL to request AAC ADTS format from Jellyfin
// The original URL is like /Audio/{id}/universal?Container=opus,mp3|mp3,...
// We change it to /Audio/{id}/stream.aac?AudioCodec=aac&... to get raw ADTS frames
function rewriteAudioUrlForAAC(url) {
    try {
        const u = new URL(url, window.location.origin);
        // Change /universal to /stream.aac (or /stream?Container=adts)
        u.pathname = u.pathname.replace(/\\/universal$/, '/stream.aac');
        // Remove fragment (e.g., #t=seconds)
        u.hash = '';
        // Force AAC codec and remove container restrictions
        u.searchParams.set('AudioCodec', 'aac');
        u.searchParams.set('TranscodingContainer', 'adts');
        u.searchParams.set('TranscodingProtocol', 'http');
        u.searchParams.delete('Container');
        u.searchParams.delete('MaxStreamingBitrate');
        console.debug('[TIZEN-MSE] rewritten URL: ' + u.toString().substring(0, 120));
        return u.toString();
    } catch (e) {
        console.error('[TIZEN-MSE] URL rewrite failed', e);
        return url;
    }
}

// Set up jMuxer MSE pipeline for audio-through-video playback on Tizen
// Build 39: Single combined feed loop — audio+video in same feed() call.
//   jMuxer mode:'both' requires audio and video together to mux correctly.
//   Feed at 15fps (67ms), ~3 audio frames per tick to match real-time.
//   Periodic screensaver suppression via global callback.
function tizenMsePlay(videoElem, audioUrl, onErrorFn) {
    console.debug('[TIZEN-MSE] starting MSE pipeline for: ' + audioUrl.substring(0, 80));

    const keyframe = getTizenKeyframe();
    if (!keyframe) {
        console.error('[TIZEN-MSE] no keyframe data');
        return Promise.reject(new Error('No H.264 keyframe data'));
    }

    // Rewrite URL to get raw AAC ADTS frames
    const aacUrl = rewriteAudioUrlForAAC(audioUrl);

    return new Promise((resolve, reject) => {
        if (typeof window.JMuxer === 'undefined') {
            console.error('[TIZEN-MSE] JMuxer not available');
            reject(new Error('JMuxer not loaded'));
            return;
        }

        let resolved = false;
        let jmuxerInstance = null;
        let feedInterval = null;        // Combined audio+video feed at 15fps
        let screenSaverInterval = null; // Periodic screensaver suppression
        let audioFrames = null;
        let audioFrameIndex = 0;
        // At 15fps (67ms per tick), need ~3 AAC frames per tick
        // (AAC frame = 1024/44100 ≈ 23.2ms, so 3 frames ≈ 69.6ms)
        const AUDIO_FRAMES_PER_TICK = 3;
        const FEED_INTERVAL_MS = 67;  // ~15fps

        // Store cleanup function on the element for destroy()
        videoElem._tizenMseCleanup = function () {
            console.debug('[TIZEN-MSE] cleanup');
            if (feedInterval) { clearInterval(feedInterval); feedInterval = null; }
            if (screenSaverInterval) { clearInterval(screenSaverInterval); screenSaverInterval = null; }
            if (jmuxerInstance) {
                try { jmuxerInstance.destroy(); } catch (e) { /* ignore */ }
                jmuxerInstance = null;
            }
            // Notify tizen.js to restore screensaver
            if (window.__tizenRestoreScreenSaver) window.__tizenRestoreScreenSaver();
            videoElem._tizenMseCleanup = null;
            videoElem._tizenJMuxer = null;
        };

        try {
            jmuxerInstance = new window.JMuxer({
                node: videoElem,
                mode: 'both',
                fps: 15,
                flushingTime: 100,
                maxDelay: 500,
                clearBuffer: false,
                debug: false,
                onReady: function () {
                    console.debug('[TIZEN-MSE] jMuxer ready (fps=15)');

                    // Start periodic screensaver suppression (every 30s)
                    if (window.__tizenSuppressScreenSaver) {
                        window.__tizenSuppressScreenSaver();
                        screenSaverInterval = setInterval(() => {
                            if (window.__tizenSuppressScreenSaver) window.__tizenSuppressScreenSaver();
                        }, 30000);
                    }

                    // Feed initial video keyframe with H.264 stream data
                    try {
                        const h264Binary = atob(TIZEN_H264_BASE64);
                        const h264Data = new Uint8Array(h264Binary.length);
                        for (let i = 0; i < h264Binary.length; i++) h264Data[i] = h264Binary.charCodeAt(i);
                        jmuxerInstance.feed({ video: h264Data, duration: 67 });
                    } catch (e) {
                        console.error('[TIZEN-MSE] initial video feed error', e);
                    }

                    // Fetch the audio file
                    console.debug('[TIZEN-MSE] fetching audio from: ' + aacUrl.substring(0, 80));
                    fetch(aacUrl, { credentials: 'same-origin' })
                        .then(response => {
                            if (!response.ok) throw new Error('HTTP ' + response.status);
                            return response.arrayBuffer();
                        })
                        .then(buffer => {
                            console.debug('[TIZEN-MSE] audio fetched: ' + buffer.byteLength + ' bytes');
                            audioFrames = extractADTSFrames(buffer);
                            console.debug('[TIZEN-MSE] extracted ' + audioFrames.length + ' ADTS frames');

                            if (audioFrames.length === 0) {
                                console.error('[TIZEN-MSE] no ADTS frames found');
                                if (!resolved) { resolved = true; reject(new Error('No ADTS frames')); }
                                return;
                            }

                            // Combined feed loop: audio + video together in each feed() call
                            // This is critical — jMuxer mode:'both' needs them together to mux
                            feedInterval = setInterval(() => {
                                if (!jmuxerInstance) {
                                    if (feedInterval) { clearInterval(feedInterval); feedInterval = null; }
                                    return;
                                }

                                // Build audio payload for this tick
                                const feedData = { video: keyframe, duration: FEED_INTERVAL_MS };

                                if (audioFrames && audioFrameIndex < audioFrames.length) {
                                    const batch = [];
                                    for (let i = 0; i < AUDIO_FRAMES_PER_TICK && audioFrameIndex < audioFrames.length; i++) {
                                        batch.push(audioFrames[audioFrameIndex++]);
                                    }
                                    if (batch.length > 0) {
                                        const totalLen = batch.reduce((s, f) => s + f.length, 0);
                                        const combined = new Uint8Array(totalLen);
                                        let offset = 0;
                                        for (const frame of batch) {
                                            combined.set(frame, offset);
                                            offset += frame.length;
                                        }
                                        feedData.audio = combined;
                                    }
                                }

                                try {
                                    jmuxerInstance.feed(feedData);
                                } catch (e) {
                                    console.error('[TIZEN-MSE] feed error', e);
                                }
                            }, FEED_INTERVAL_MS);

                            // Start playback
                            const tryPlay = () => {
                                videoElem.play().then(() => {
                                    console.debug('[TIZEN-MSE] playing');
                                    if (!resolved) { resolved = true; resolve(); }
                                }).catch(e => {
                                    console.debug('[TIZEN-MSE] play() retry: ' + e.message);
                                    videoElem.addEventListener('canplay', function onCanPlay() {
                                        videoElem.removeEventListener('canplay', onCanPlay);
                                        videoElem.play().then(() => {
                                            console.debug('[TIZEN-MSE] playing after canplay');
                                            if (!resolved) { resolved = true; resolve(); }
                                        }).catch(e2 => {
                                            console.error('[TIZEN-MSE] play failed', e2);
                                            if (!resolved) { resolved = true; reject(e2); }
                                        });
                                    });
                                });
                            };
                            setTimeout(tryPlay, 200);
                        })
                        .catch(err => {
                            console.error('[TIZEN-MSE] fetch error', err);
                            if (!resolved) { resolved = true; reject(err); }
                        });
                },
                onError: function (err) {
                    console.error('[TIZEN-MSE] jMuxer error', err);
                    if (!resolved) { resolved = true; reject(new Error('jMuxer error')); }
                }
            });

            videoElem._tizenJMuxer = jmuxerInstance;
        } catch (e) {
            console.error('[TIZEN-MSE] init error', e);
            reject(e);
        }
    });
}
// === TIZEN MSE PATCH END ===
`;

// Insert the MSE helpers right after the class opening
// We'll add them before the class definition
const classMarker = 'class HtmlAudioPlayer {';
if (!src.includes(classMarker)) {
    console.error('ERROR: Cannot find class HtmlAudioPlayer');
    process.exit(1);
}
src = src.replace(classMarker, MSE_HELPERS + '\n' + classMarker);
console.log('Patch 2 applied: Added MSE helper functions');

// ============================================================
// Patch 3: Modify native playback path to use MSE on Tizen
// ============================================================

// The native path (enableHlsPlayer rejection handler) currently does:
//   elem.autoplay = true;
//   ... get credentials ...
//   return htmlMediaHelper.applySrc(elem, val, options).then(function () {
//       self._currentSrc = val;
//       return htmlMediaHelper.playWithPromise(elem, onError);
//   });
//
// We want to wrap this so on Tizen it uses MSE instead.

// Find the rejection handler of enableHlsPlayer
const nativePathOld = `return htmlMediaHelper.applySrc(elem, val, options).then(function () {
                    self._currentSrc = val;

                    return htmlMediaHelper.playWithPromise(elem, onError);
                });`;

const nativePathNew = `// TIZEN MSE PATCH: Use MSE pipeline on Tizen for audio-through-video
                console.debug('[TIZEN-MSE] native path: browser.tizen=' + !!browser.tizen + ' JMuxer=' + (typeof window.JMuxer) + ' MediaSource=' + (typeof MediaSource) + ' isAudio=' + /\\/Audio\\//i.test(val));
                console.debug('[TIZEN-MSE] elem type=' + elem.nodeName + ' url=' + (val || '').substring(0, 100));
                if (browser.tizen && typeof window.JMuxer !== 'undefined' && typeof MediaSource !== 'undefined' && /\\/Audio\\//i.test(val)) {
                    console.debug('[TIZEN-MSE] => using MSE pipeline');
                    self._currentSrc = val;
                    return tizenMsePlay(elem, val, onError);
                }
                console.debug('[TIZEN-MSE] => using native path (fallback)');
                return htmlMediaHelper.applySrc(elem, val, options).then(function () {
                    self._currentSrc = val;

                    return htmlMediaHelper.playWithPromise(elem, onError);
                });`;

if (!src.includes(nativePathOld)) {
    console.error('ERROR: Cannot find native playback path in setCurrentSrc');
    console.error('Looking for:', nativePathOld.substring(0, 80));
    process.exit(1);
}
src = src.replace(nativePathOld, nativePathNew);
console.log('Patch 3 applied: Native path uses MSE on Tizen for audio URLs');

// ============================================================
// Patch 4: Modify destroy() to clean up MSE
// ============================================================

const destroyOld = `self.destroy = function () {
            unBindEvents(self._mediaElement);
            htmlMediaHelper.resetSrc(self._mediaElement);
        };`;

const destroyNew = `self.destroy = function () {
            // TIZEN MSE PATCH: Clean up jMuxer before resetting src
            if (self._mediaElement && self._mediaElement._tizenMseCleanup) {
                self._mediaElement._tizenMseCleanup();
            }
            unBindEvents(self._mediaElement);
            htmlMediaHelper.resetSrc(self._mediaElement);
        };`;

if (!src.includes(destroyOld)) {
    console.error('ERROR: Cannot find destroy() function');
    process.exit(1);
}
src = src.replace(destroyOld, destroyNew);
console.log('Patch 4 applied: destroy() cleans up MSE');

// ============================================================
// Patch 5: Modify stop() to clean up MSE
// ============================================================

// In the stop function, onEndedInternal is called which calls resetSrc.
// We need to clean up MSE before that happens.
const stopOld = 'htmlMediaHelper.onEndedInternal(self, elem, onError);';
const stopNew = `// TIZEN MSE PATCH: Clean up jMuxer before ending
                    if (elem._tizenMseCleanup) { elem._tizenMseCleanup(); }
                    htmlMediaHelper.onEndedInternal(self, elem, onError);`;

// Replace all occurrences in stop()
src = src.split(stopOld).join(stopNew);
console.log('Patch 5 applied: stop() cleans up MSE');

// ============================================================
// Verify and write
// ============================================================

if (src === original) {
    console.error('ERROR: No changes were made');
    process.exit(1);
}

fs.writeFileSync(PLUGIN_PATH, src, 'utf8');
console.log('Successfully patched: ' + PLUGIN_PATH);
console.log('Total bytes: ' + original.length + ' -> ' + src.length);
