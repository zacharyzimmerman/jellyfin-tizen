# Jellyfin for Samsung Tizen (Custom Fork)

Custom build of [Jellyfin Tizen](https://github.com/jellyfin/jellyfin-tizen) for the Samsung QN55S95DAFXZA (2024 S95D OLED), with fixes for OLED screensaver burn-in, audio buffering, and a now-playing album art screen.

Based on [jellyfin-web](https://github.com/jellyfin/jellyfin-web) `release-10.10.z`.

## Features

### OLED Screensaver Bypass
Samsung's OLED firmware triggers a screensaver/pixel-shift during audio-only playback (no video signal). This fork loops a tiny fullscreen video (`screensaver-bypass.mp4`, 25KB, 128x72, 2fps) behind the UI and calls the Tizen screensaver API to keep the screen on during music playback.

### Album Art Now-Playing Screen
A fullscreen overlay showing album art, track info, and a progress bar during audio playback. Fetches playback state directly from the Jellyfin Sessions API.

- Blurred album art background with large centered artwork
- Track title, artist, album, and progress bar
- D-pad navigable transport controls: Previous, Rewind 10s, Play/Pause, Forward 10s, Next
- Previous track restarts the current track if more than 3 seconds in
- Accessible via a header button (album icon) that appears during audio playback
- Back button returns to the normal Jellyfin UI

### HLS.js Buffer Override
jellyfin-web 10.10.z caps `maxMaxBufferLength` at 6 seconds, which causes audio sticking on slower connections. This fork monkey-patches the HLS.js constructor to increase buffer limits:

| Setting | Default | Override |
|---------|---------|----------|
| `maxMaxBufferLength` | 6s | 120s |
| `maxBufferLength` | 3s | 30s |
| `maxBufferSize` | 30MB | 60MB |

### Server Address Pre-Fill
Pre-fills the server URL input field on the "Add Server" screen for faster initial setup.

## Install

1. Download `Jellyfin.wgt` from the [latest release](https://github.com/zacharyzimmerman/jellyfin-tizen/releases/latest)
2. Enable Developer Mode on your Samsung TV:
   - Open the Apps panel
   - Press `1-2-3-4-5` on the remote
   - Enable Developer Mode and enter your PC's IP address
   - Restart the TV
3. Sideload the `.wgt` file using one of:
   - [Jellyfin2Samsung Installer](https://github.com/Jellyfin2Samsung/Samsung-Jellyfin-Installer) (easiest)
   - Tizen Studio CLI (`sdb connect <TV_IP> && tizen install -n Jellyfin.wgt -t <device>`)

## Build from Source

### Prerequisites
- Node.js 20+
- Tizen Studio 4.5+ with CLI
- Git

### Steps

```sh
# Clone repos
git clone https://github.com/zacharyzimmerman/jellyfin-tizen.git
git clone -b release-10.10.z https://github.com/jellyfin/jellyfin-web.git

# Build jellyfin-web
cd jellyfin-web
npm ci --no-audit
USE_SYSTEM_FONTS=1 npm run build:production
cd ..

# Build jellyfin-tizen
cd jellyfin-tizen
JELLYFIN_WEB_DIR=../jellyfin-web/dist npm ci --no-audit

# Package .wgt (requires Tizen certificate setup)
tizen build-web -e ".*" -e gulpfile.babel.js -e README.md -e "node_modules/*" -e "package*.json" -e "yarn.lock" -e "jellyfin-web/*"
tizen package -t wgt -o . -- .buildResult
```

The CI workflow (`.github/workflows/build.yml`) automates this — trigger it via GitHub Actions to produce a release with the `.wgt` artifact.

## Architecture

All custom behavior lives in `tizen.js`, which is injected into the jellyfin-web index.html at build time by the gulp pipeline. The jellyfin-web source is unmodified.

| File | Purpose |
|------|---------|
| `tizen.js` | Tizen adapter — screensaver bypass, album art page, HLS buffer patch, D-pad key handling, server pre-fill |
| `screensaver-bypass.mp4` | Minimal looping video for OLED burn-in prevention (25KB, H.264 Baseline, 128x72, 2fps, 60s) |
| `config.xml` | Tizen widget manifest — app ID, version, privileges |
| `gulpfile.babel.js` | Build pipeline — copies jellyfin-web dist, injects tizen.js into index.html |

## Remote Control Mapping

When the album art screen is open:

| Key | Action |
|-----|--------|
| Left/Right | Navigate between transport buttons |
| Enter/OK | Activate focused button |
| Back | Close album art screen |
| Media Play/Pause | Toggle playback |
| Media Previous/Next | Previous/next track |
| Media Rewind/FF | Seek back/forward 10 seconds |
