# Baseline

Recorded before any integration change.

- Local repository: `D:\Projects\hbg-life-simulation`
- Upstream: https://github.com/Mr-funny/hbg-life-simulation
- Fork (created for this task): https://github.com/Xander-Xai/hbg-life-simulation
- Branch at baseline: `main`
- Baseline commit: `288f780c2f5ccce975e11dd3c5ff6d6eda15afa6`
- Working tree at baseline: clean, `main...origin/main`
- Push access to upstream: none (`pull: true`, `push: false`); the fork is the only writable remote.

## Toolchain

| Tool | Version |
|---|---|
| OS | Windows 11 (win32), Git Bash / PowerShell 7 |
| Node.js | v24.16.0 (requirement: 22+) |
| npm | 11.13.0 |
| FFmpeg / FFprobe | 8.1.1 (gyan.dev essentials) |
| Python | 3.13.15, `edge-tts` 7.3.1 |
| HyperFrames CLI | 0.8.222 (via `npx hyperframes`) |
| media-use | bundled in the HyperFrames package; `resolve --doctor` reports 19 bundled SFX, no heygen CLI |

## Existing checks

`.github/workflows/ci.yml` on ubuntu-latest, Node 22: shell syntax, `.mjs` syntax, SKILL.md frontmatter, style JSON, credential scan, style init smoke test, installer help, consent-gated CLIProxyAPI bootstrap tests.

## Pre-existing data flow

```
SCRIPT_SOURCE.md + PROJECT_SPEC.json
  → build_script.mjs            → SCRIPT.md
  → build_storyboard_base.mjs   → STORYBOARD_BASE.json
  → build_narration.mjs         → Edge TTS + VTT → STORYBOARD.json + audio_meta.json
  → build_composition.mjs       → compositions/*.html + index.html + looped BGM
  → render_streaming_ffmpeg.mjs → MP4
  → verify_final_video.sh       → QA probes and frames
```

`PROJECT_SPEC.audio.bgmSource` is looped to the full duration by `build_composition.mjs`; `audio_meta.opening.flash.video` and `.audio` were both set from `PROJECT_SPEC.opening.flashMedia` by `build_narration.mjs`.
