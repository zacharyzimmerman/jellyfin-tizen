# Screensaver Bypass: Approach History

Samsung QN55S95DAFXZA (2024 S95D 55" OLED, Tizen OS 5.3). The firmware forces a screensaver after ~2 minutes of static pixels during audio-only playback. Goal: suppress it from within the sideloaded Jellyfin Tizen app.

## Approach 1: Samsung AppCommon API (`setScreenSaver`)

**Commit:** `06e6d4a` Suppress Samsung screen saver during media playback
**Idea:** Call `webapis.appcommon.setScreenSaver(SCREEN_SAVER_OFF)` during playback.
**Result on TV:** Did NOT suppress the OLED burn-in screensaver. The API controls a different screensaver (the "ambient" one), not the mandatory OLED burn-in protection.

## Approach 2: Tizen Power API (`tizen.power.request`)

**Commit:** `1afabdf` Add Tizen Power API as fallback for screen wake lock
**Idea:** `tizen.power.request('SCREEN', 'SCREEN_NORMAL')` to keep screen awake.
**Result on TV:** Did NOT work. The OLED burn-in protection is firmware-level, independent of the power API. The power API prevents screen dimming/off but not the burn-in screensaver.

## Approach 3: CSS Gradient Animation Overlay

**Commit:** `9c33c37` Add OLED burn-in prevention overlay during audio playback
**Idea:** Inject a subtle slow-moving dark gradient behind the UI. The pixel changes would prevent the firmware's static pixel detection from triggering.
**Result on TV:** Did NOT work. The gradient was placed behind the page background (z-index:-1) making it invisible.

**Fix attempt:** `6761e5c` — moved overlay on top with opacity:0.07.
**Result on TV:** Still did NOT work. The firmware doesn't check for CSS pixel changes — it checks for video decoder activity.

## Approach 4: Canvas Noise Overlay

**Commit:** `87ba310` v0.6.0: Switch to canvas noise overlay
**Idea:** Full-screen canvas with per-pixel random noise at ~4-7% alpha, redrawn every animation frame. Every pixel changes every frame.
**Result on TV:** Did NOT work. Same reason — the firmware checks for hardware video decoder activity, not pixel changes on screen.

## Approach 5: Hidden Video with captureStream()

**Commit:** `c768b80` v0.7.0: Use hidden video stream to bypass OLED screensaver
**Idea:** Play a hidden `<video>` element fed by `canvas.captureStream()`. The TV should detect active video playback.
**Result on TV:** Did NOT work. `captureStream()` creates a software MediaStream that isn't routed through the hardware video decoder. The firmware doesn't recognize it as "video playing."

## Approach 6: Data URI H.264 MP4 (Loop)

**Commit:** `e9bc993` Use real H.264 MP4 for screensaver suppression
**Idea:** Embed a real ~1kB H.264 MP4 as a data: URI, play it looping on a hidden `<video>`. Real H.264 should engage the hardware decoder.
**Result on TV:** Did NOT work. Likely because data: URI playback doesn't go through the standard media pipeline on Tizen, or the element was too small (1x1px) to register.

## Approach 7: Synthetic Keypress Events

**Commit:** `9b8816a` Add periodic synthetic keypress to prevent OLED screensaver (Method 4)
**Idea:** Dispatch a synthetic `KeyboardEvent` (ColorF0Red / keyCode 403) every 90 seconds during playback to simulate user activity.
**Result on TV:** Did NOT work. Synthetic JS keyboard events don't reach the firmware's input activity detector.

## Approach 8: Full-Screen Hidden Video (Data URI)

**Commit:** `2d399b2` Make dummy video full-screen to pass firmware size check
**Idea:** Make the data URI video 100% viewport (instead of 1x1px) with near-zero opacity, in case the firmware has a size check.
**Result on TV:** Did NOT work. The fundamental issue is that data: URI videos don't engage the hardware decoder on Tizen.

## Approach 9: PiP Video from Jellyfin Server

**Commits:** `327649c`, `f3a15ae`, `6f7084d`, `be56234`, `3082739`, `7cd0a5c`
**Idea:** Fetch a random real video from the Jellyfin server and play it muted in a small visible PiP window (192x108). This uses the same pipeline as normal Jellyfin video playback, which DOES suppress the screensaver.
**Result on TV:** The video played but **it killed the audio playback**. Samsung Tizen has a single media element limitation — starting the `<video>` paused the `<audio>`.

Multiple fixes attempted:
- Delay PiP creation by 3s, resume audio after PiP starts → **still ping-ponged**
- Video-only transcode (no audio track), guard flags to ignore pause events → **audio and video could not coexist**

**Key finding:** Only ONE `<audio>` or `<video>` element can actively play at a time on Tizen. Starting a second element pauses the first.

## Approach 10: Audio-to-Video Element Swap (Return `<video>` from createElement)

**Commit:** `da72a8c` feat: replace PiP with audio-to-video element swap
**Idea:** Override `document.createElement('audio')` to return a `<video>` element instead. jellyfin-web treats it as audio (same HTMLMediaElement API), but the firmware sees `<video>` and suppresses the screensaver.
**Result on TV:** Did NOT work — "media type not supported" error. When `<video>.canPlayType('audio/...')` was called during device profile probing, it returned `''` (not supported), causing jellyfin-web to build an incompatible device profile.

## Approach 11: jMuxer MSE (Audio-to-Video at Playback Time)

**Commit:** `1b7a77f` feat: jMuxer MSE pipeline for screensaver bypass
**Idea:** Return a real `<audio>` from createElement (preserving canPlayType), but when an audio URL is set, intercept it and route through jMuxer MSE — muxing AAC audio (from ADTS stream) with H.264 black video frames into a `<video>` element. Engages the hardware decoder.
**Result on TV (Build ~25):** "media type not supported" — the 16x16 H.264 resolution was below Tizen's minimum for the hardware decoder.

## Approach 12: jMuxer MSE with 128x128 H.264 + Fallback

**Commit:** `c2268a7` fix: bump H.264 to 128x128, add MSE diagnostics
**Idea:** Bump H.264 from 16x16 to 128x128 (Constrained Baseline, Level 1.3). Add MediaSource.isTypeSupported() pre-checks and fallback to native if MSE fails.
**Result on TV:** MSE codec diagnostics all showed TRUE (all codecs supported). But element swap broke jellyfin-web — the old `<audio>` element's event listeners were on a detached element.

## Approach 13: Audio Element Swap with DOM Replacement

**Commit:** `e532c11` fix: return real `<audio>`, swap to `<video>` at playback time
**Idea:** Return real `<audio>` from createElement. When audio URL is set, create a `<video>`, copy attributes, replace `<audio>` in DOM with `<video>`, start MSE pipeline.
**Result on TV:** jellyfin-web's `_mediaElement` reference went stale. play()/pause() hit the detached `<audio>`. Event listeners (timeupdate, ended) never fired on the new `<video>`.

## Approach 14: Proxy Pattern (v0.10.0, Builds 26-34)

**Commit:** `f588a99` fix: use proxy pattern instead of DOM swap
**Idea:** Keep `<audio>` as jellyfin-web's API surface. Create hidden `<video>` for MSE. Proxy play(), pause(), volume, currentTime, duration, paused, ended, buffered, readyState, networkState, error between the two. Forward events from `<video>` → `<audio>`.

### Build 26-28: Basic proxy + debug overlay
**Result on TV:** MSE codecs all supported. Proxy pipeline started. But something immediately set `src=""` which tore down the proxy.

### Build 29: Auto-authenticate test account
**Result on TV:** Auth succeeded but jellyfin-web's connection flow didn't accept pre-stored credentials. Had to manually add server.

### Build 30: Add readyState/networkState/error proxy + teardown stack trace
**Result on TV:** Stack trace showed `t.destroy` in `htmlAudioPlayer-plugin/...bundle.js` was calling `resetSrc()` which sets `src=""`.

### Build 31: Block src="" during proxy
**Result on TV:** Blocking src="" kept the proxy alive, but still got "problem with media playback" error.

### Build 32: Multi-line stack traces
**Result on TV:** Confirmed two BLOCKED src="" events — both `.src=""` and `removeAttribute('src')` caught. Both from `t.destroy`.

### Build 33: Unfiltered debug + numbered audio elements
**Result on TV:** Full sequence visible:
1. Audio #3 created, src set to audio URL
2. MSE proxy started and configured
3. play() proxied to `<video>`
4. src="" → BLOCKED
5. hideMediaSession fires

### Build 34: Fix play() promise + remove error forwarding
**Root cause found:** jellyfin-web's `playWithPromise()` calls `elem.play()` and rejects if the promise fails. Our proxy delegated to `videoEl.play()` which rejected because MSE hadn't buffered data yet. This triggered `destroyPlayer()`.

**Fixes:** play() returns `Promise.resolve()` immediately, defers actual video.play() to canplay. Removed 'error' from forwarded events.

**Result on TV:** MSE pipeline ran end-to-end for the first time:
- play() resolved
- canplay fired
- video.play() executed
- audio stream started

**BUT:** "It's not playing." Progress bar doesn't move. `hideMediaSession` fires. jellyfin-web has already called `destroy()` and abandoned the player — it removed all event listeners from the audio element and moved on. The proxy is running but nobody is listening.

**Conclusion:** The proxy approach is fundamentally incompatible with jellyfin-web's player lifecycle. `htmlAudioPlayer.destroy()` fires immediately after play() (triggered by the original play() promise resolution/rejection path), removes all bindings, and the playback manager considers the player dead. No amount of interception can prevent this.

## Approach 15: Side-Channel Video-Only MSE (v0.11.0, Build 35)

**Commit:** `f8b9991` v0.11.0: Side-channel video-only MSE
**Idea:** Don't intercept anything. Let jellyfin-web's native `<audio>` playback work 100% unmodified. Separately, when audio starts playing, create a hidden MUTED `<video>` element and feed it H.264-only keyframes via jMuxer MSE (`mode: 'video'`, no audio track). The video decoder stays active to suppress the screensaver.

**Hypothesis:** The single-element limitation (from Approach 9) may only apply when both elements produce audio. A muted video-only MSE stream with no audio track might coexist with native audio playback.

**Result on TV:** NOT YET TESTED.

**Risk:** If the single-element limitation blocks ALL concurrent media elements regardless of audio tracks, this approach will fail the same way as the PiP approach — starting the video will pause the audio.

## Approach 16: Source-Patched Audio-to-Video MSE (v0.12.0, Build 36)

**Idea:** Instead of runtime interception, modify jellyfin-web's source code at build time. A Node.js patch script (`patches/apply-tizen-video-patch.cjs`) modifies `htmlAudioPlayer/plugin.js` before webpack builds it:

1. `createMediaElement()` creates `<video>` instead of `<audio>` on Tizen (`browser.tizen` detection)
2. The native playback path (which runs on Tizen since HLS.js is disabled for `browser.tizen`) checks for `/Audio/` URLs and routes them through `tizenMsePlay()` — a jMuxer MSE pipeline that muxes H.264 128x128 black keyframes + ADTS AAC audio into the `<video>` element
3. `destroy()` and `stop()` clean up the jMuxer instance before resetting src

**Key difference from proxy pattern (Builds 26-34):** The `<video>` IS `self._mediaElement` — no proxy, no stale references, no detached elements. All event listeners (timeupdate, ended, pause, etc.) are bound directly to the video element. `destroy()` operates on the actual element.

**Key difference from side-channel (Build 35):** Only ONE media element exists. No second element to compete with the single-element limitation. The video decoder is active because jMuxer feeds real H.264 keyframes alongside the audio.

**tizen.js simplified:** Removed all interception/side-channel code (~400 lines). Only provides NativeShell/AppHost adapter, server pre-fill, debug overlay, and belt-and-suspenders screensaver API calls.

**Result on TV:** NOT YET TESTED.

**Risks:**
- jMuxer MSE buffering timing: `play()` may fire before MSE has buffered data. Mitigated by retry logic (play → fail → wait for canplay → retry).
- ADTS extraction: If the audio stream isn't raw AAC/ADTS (e.g., it's Ogg, FLAC, or already muxed MP4), `extractADTSFrames()` will return 0 frames and the pipeline will reject — falling back to native `<video>` src assignment.
- `<video>` playing non-MSE audio URLs: If jMuxer/MSE isn't available, the patch falls back to native `applySrc()` + `playWithPromise()` on the `<video>` element. Whether `<video>` can play raw audio URLs on Tizen is unconfirmed.

---

## Summary of What Works / Doesn't

| Method | Suppresses Screensaver? | Audio Keeps Playing? |
|--------|------------------------|---------------------|
| AppCommon API | No (wrong screensaver) | N/A |
| Power API | No (different mechanism) | N/A |
| CSS animation | No (not video decoder) | N/A |
| Canvas noise | No (not video decoder) | N/A |
| captureStream video | No (software stream) | N/A |
| Data URI H.264 | No (not hw decoder) | N/A |
| Synthetic keypress | No (doesn't reach FW) | N/A |
| Full-screen data URI | No (not hw decoder) | N/A |
| PiP real video | **Untested** (audio killed) | **No** — single element limit |
| Return `<video>` element | N/A (broke canPlayType) | N/A |
| jMuxer MSE 16x16 | N/A (codec rejected) | N/A |
| jMuxer MSE 128x128 swap | N/A (stale reference) | N/A |
| Proxy pattern (Builds 26-34) | **Untested** (player destroyed) | **No** — jellyfin-web destroys player |
| Side-channel muted video (Build 35) | **Untested** | **Unknown** — depends on single-element scope |
| Source-patched audio-to-video MSE (Build 36) | **Untested** | **Likely yes** — single element, audio in MSE |

**The fundamental unanswered questions:**
1. Does H.264 via MSE on a `<video>` element actually suppress the OLED screensaver?
2. Does jMuxer's fMP4 muxing of H.264+AAC produce playable output on Tizen's MSE implementation?
3. Can the ADTS extraction handle the audio format Jellyfin/Navidrome serves?

None have been tested on the actual TV yet.
