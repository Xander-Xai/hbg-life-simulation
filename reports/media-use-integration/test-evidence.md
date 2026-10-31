# Test evidence

All commands below were executed locally on 2026-10-31 (Windows 11, Node 24.16.0, FFmpeg 8.1.1).

## 1. Offline unit and integration suite

```
node --test tests/*.test.mjs
```

Result: **29 tests, 29 pass, 0 fail** (exit 0).

| File | Coverage |
|---|---|
| `tests/resolve_media.test.mjs` | CLI argument construction, JSON and one-line parsing, binding reuse, cache reuse, dedup, path escape, missing file, provider failure/auth/timeout, invalid JSON, production authorization, license/publish rules, normalization, dry run, usage errors |
| `tests/prepare_media.test.mjs` | opt-in switch, legacy skip, BGM+SFX resolution, idempotency, local ingest, SFX fallback provenance, partial failure reporting, verify-only, `--enable` |
| `tests/opening_audio.test.mjs` | flash video/audio decoupling and legacy compatibility |
| `tests/pipeline_integration.test.mjs` | composition binds the separate SFX, looped BGM rebuilt, legacy single-path preserved, streaming render produces video+audio |

The fake CLI (`tests/fixtures/fake_media_use.mjs`) is driven by `FAKE_MEDIA_MODE`; no network, account or paid provider is used.

## 2. Real media-use, offline mode

Project: `D:\Temp\AI-Agents\claude\hbg-e2e-real`

```
node scripts/prepare_media.mjs --project <project> --json
```

- BGM: ingested from a local user file through `media-use resolve --from` → `assets/audio/bgm/bgm_001.mp3` (10.000 s).
- SFX: bundled `whoosh-cinematic` resolved offline, normalized to the flash duration → `assets/audio/sfx/sfx_001-1.667s.m4a` (1.667 s).
- `PROJECT_SPEC.audio.bgmSource` and `PROJECT_SPEC.opening.flashSfx` were written automatically.
- `assets/media/hbg-media-index.json` records id, SHA-256, provider, duration and `LICENSE_UNVERIFIED` / `publishAllowed: false`.

```
node scripts/prepare_media.mjs --project <project> --verify-only --json
```

Result: exit 0, both bindings valid.

## 3. Real narration with Edge TTS

```
node scripts/build_narration.mjs
```

- 2 chapters, 7 captions, body narration 15.744 s, total 23.029 s.
- `audio_meta.opening.flash.video = assets/opening/flash.mp4`
- `audio_meta.opening.flash.audio = assets/audio/sfx/sfx_001-1.667s.m4a`
- The two tracks are different, which the pre-integration code could not express.

## 4. Real composition

```
node scripts/build_composition.mjs
```

- `index.html` contains `id="audio-opening-ratchet" src="assets/audio/sfx/sfx_001-1.667s.m4a"`.
- Loop BGM rebuilt at `assets/audio/bgm/looped.m4a` for 23.029 s at the style's fixed volume.
- `validate_style_system.mjs`: exit 0, `flashMotionDelta 2.293`, `selectedMotionDelta 2.848`.

## 5. Real video render and QA

```
node scripts/render_streaming_ffmpeg.mjs . renders/e2e-v1.mp4
bash scripts/verify_final_video.sh renders/e2e-v1.mp4 qa/final 1:opening 5:title 12:body 20:ending
```

- Output: 1920×1080, 23.029 s, 691 frames, 8,146,884 bytes, video + audio streams present.
- Black frame events: 0.
- Silence events: 0.
- Integrated loudness in range, true peak `-7.3 dBFS` (loudness range 4.7 LU).
- Contact sheet visually checked: opening frames and body frames show the burned-in Chinese captions inside the safe area.

## 6. Adversarial checks exercised

| ID | Scenario | Result |
|---|---|---|
| T05 | Provider unavailable, cache hit | pass — no CLI call, binding restored |
| T06 | Production mode without authorization | pass — exit 5, no provider contact |
| T07 | Provider reports a missing file | pass — exit 4, spec unchanged |
| T07b | Unreadable asset | pass — `ffprobe` rejection |
| T11 | Provider failure / auth | pass — exit 3 / exit 5 with `blocked` |
| T11b | Hung provider | pass — killed at the 800 ms test budget |
| T12 | Path escape (`../../`) | pass — `path_escape`, exit 4 |
| T13 | Repeated content | pass — one file, `copied: false` |
| T14 | Publish flag with unverified license | pass — remains `publishAllowed: false` |
| T15 | Invalid JSON output | pass — `media_output_unparsed`, exit 3 |
| T19 | Repeated preparation | pass — all results `reused-binding`, no new files |

## Not run

| Item | Status | Reason |
|---|---|---|
| HeyGen catalog BGM / image / voice resolve | NOT_RUN | requires account sign-in; prohibited without user consent |
| `--mode production` against a live provider | NOT_RUN | no authorized provider configured |
| GitHub Actions run | NOT_RUN at commit time | workflow executes after the branch is pushed |
| Full HyperFrames `check --strict` render | NOT_RUN | requires a real HyperFrames project preview; streaming FFmpeg path was verified instead |
