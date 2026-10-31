# Architecture audit

Scope: read-only audit of the repository at `288f780` before integration.

## Existing capabilities

| Area | Where | Notes |
|---|---|---|
| Source freezing | `build_script.mjs` | corrections are applied only from `PROJECT_SPEC.source.corrections` |
| Storyboard normalisation | `build_storyboard_base.mjs` | validates chapter order, cues, motion cycle |
| Narration + captions | `build_narration.mjs` | one continuous Edge TTS body, VTT master timeline, semantic caption splitting |
| Opening timing | `build_narration.mjs` | lead → flash → reveal → body, all derived from real TTS durations |
| Composition | `build_composition.mjs` | builds HyperFrames HTML, loops BGM with FFmpeg |
| Streaming render | `render_streaming_ffmpeg.mjs` | low-disk FFmpeg path using the same `audio_meta.json` |
| Style gate | `validate_style_system.mjs` | orientation, caption safe area, flash motion |
| Final QA | `verify_final_video.sh` | black/silence/loudness + contact sheet |

## Missing capabilities

1. No media supply layer: BGM and the flash SFX must be placed by hand.
2. No provenance record for media: no SHA-256, provider, license or reuse tracking.
3. No offline reuse across projects.
4. `audio_meta.opening.flash.video` and `.audio` are identical by construction — a separate SFX cannot be expressed.
5. No test suite and no test runner in CI.

## Code that had to change

| File | Change | Reason |
|---|---|---|
| `scripts/build_narration.mjs` | flash video/audio resolved via `opening_audio.mjs`; `flashSfx` existence check; Windows `python` fallback | independent SFX; portability blocking local runs |
| `scripts/build_composition.mjs` | assert lead/reveal/flash audio files exist | fail fast instead of emitting a broken composition |
| `scripts/make_contact_sheet.sh` | `cygpath -w` for concat list entries | native FFmpeg resolved MSYS paths as `D:/d/...` |
| `.github/workflows/ci.yml` | offline test step + media entry smoke test | verify the new code in a clean environment |

## Code that must not change

- Character anchor / 2×2 sheet / high-risk frame logic and prompts (`SKILL.md`, `references/*`).
- Edge TTS body continuity, VTT alignment, caption splitting thresholds.
- Orientation defaults (1920×1080 landscape, 1080×1920 only on request).
- Zoom/pan motion values, opening timeline, BGM fixed-gain policy.
- Local-account image API consent gate (`setup_local_cliproxyapi.sh`, `PROJECT_SPEC.imageGeneration`).

## Compatibility risks

- A malformed `PROJECT_SPEC.opening.flashSfx` would previously be ignored; now `build_narration.mjs` fails early. This is intentional, but only triggers when the field is present.
- The new assertions in `build_composition.mjs` require lead/reveal/flash audio to exist. Existing projects already produce these files through `build_narration.mjs`.
- `mediaUse` is opt-in (`enabled: false` by default); projects without it behave exactly as before.
- Windows spawn of `.cmd` shims is avoided by invoking `npx-cli.js` through Node; POSIX is unchanged.
- The bundled SFX library has no literal ratchet; an offline intent without a match falls back to a disclosed transition cue, never to music or video.
