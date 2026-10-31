# media-use integration

HBG keeps ownership of story, character identity, narration, captions, storyboarding and final QA. `media-use` is used only as a **media supply layer** for background music and the opening flash SFX.

## Workflow position

```text
中文故事
  → SCRIPT_SOURCE.md / PROJECT_SPEC.json
  → [0.5 prepare-media] ──► media-use resolve ──► assets/audio/{bgm,sfx}
  │                                              └► assets/media/hbg-media-index.json
  → 角色锚点 / 分镜 / 生图（HBG 原有流程，不受影响）
  → Edge TTS + VTT（不变）
  → build_composition / render_streaming_ffmpeg
  → 最终 MP4 QA（不变）
```

The media step runs **after** `PROJECT_SPEC.json` and `HBG_STYLE.json` exist and **before** composition building. It never runs during a render.

## Components

| File | Responsibility |
|---|---|
| `scripts/media_common.mjs` | CLI invocation, output parsing, audio probing, path-boundary checks, atomic copies, provenance index, license defaults |
| `scripts/resolve_media.mjs` | Resolve one `bgm`/`sfx` asset: binding reuse → project index → media-use → validate → copy → bind → record |
| `scripts/prepare_media.mjs` | Project-level orchestration: read `PROJECT_SPEC.mediaUse`, resolve BGM and SFX, normalize SFX to the flash duration, write `prepare-report.json` |
| `scripts/opening_audio.mjs` | `flashMedia` vs `flashSfx` resolution shared by narration and composition |

## Data flow

1. `prepare_media.mjs` reads `PROJECT_SPEC.json`.
2. For each type it checks, in order:
   1. an existing binding in `audio.bgmSource` / `opening.flashSfx` (`reused-binding`, no provider call);
   2. `assets/media/hbg-media-index.json` for a valid, hash-matching entry (`reused-cache`, no provider call);
   3. `media-use resolve` with an argument array (no shell, no string interpolation);
   4. for SFX in `local-only` mode only, the bundled fallback cues.
3. The result is validated (file exists and is non-empty, project-relative, `ffprobe` finds an audio stream, positive duration).
4. The asset is copied atomically into `assets/audio/{bgm,sfx}/`; identical content is deduplicated by SHA-256.
5. Provenance is appended to `assets/media/hbg-media-index.json`.
6. `PROJECT_SPEC.audio.bgmSource` / `PROJECT_SPEC.opening.flashSfx` are updated atomically.
7. `build_narration.mjs` writes `audio_meta.opening.flash.video = flashMedia` and `.audio = flashSfx ?? flashMedia`.
8. `build_composition.mjs` and `render_streaming_ffmpeg.mjs` consume `audio_meta` and therefore share one timeline.

## Configuration schema

```json
{
  "mediaUse": {
    "enabled": true,
    "mode": "local-only",
    "allowExternalProviders": false,
    "bgm": { "intent": "…", "from": "assets/audio/bgm/user-pick.mp3", "reuse": "<sha256-prefix>", "license": "CC0-1.0", "publishAllowed": false },
    "sfx": { "intent": "…", "localFallbackCues": ["whoosh-cinematic", "riser", "impact-bass-1"], "normalizeDuration": true }
  }
}
```

`enabled` defaults to false: a project without this block behaves exactly as before this integration.

## Provenance record

Each entry in `assets/media/hbg-media-index.json` carries:

`id`, `type`, `intent`, `intentHash`, `localPath`, `originalPath`, `preparedFrom`, `sha256`, `bytes`, `duration`, `codec`, `sampleRate`, `channels`, `provider`, `source`, `mediaUseId`, `mediaUseManifest`, `outputFormat`, `license`, `licenseNote`, `publishAllowed`, `usage`, `verified`, timestamps.

Rules:

- Provider, bundled-library and user-provided assets start as `LICENSE_UNVERIFIED` with `publishAllowed: false`.
- `publishAllowed` becomes true only when the user supplies an explicit `mediaUse.<type>.license` **and** requests publication.
- No endpoint, API key, OAuth record, account id or story text is ever recorded.

## Cache and idempotency

- media-use owns `.media/manifest.jsonl`, `.media/index.md` and the global `~/.media/` cache.
- HBG keeps its own binding index so a cache hit does not depend on media-use being reachable.
- Re-running `prepare_media.mjs` reuses valid bindings and indexed entries; it does not download, copy or rewrite anything.
- `--force` re-resolves, but identical content is still deduplicated by hash instead of producing duplicate files.

## Failure strategy

| Situation | Behaviour | Exit |
|---|---|---|
| media-use missing | `blocked` / `media_cli_missing` | 5 |
| Provider needs sign-in | `blocked` / `provider_auth_required`; never logs in | 5 |
| production mode without authorization | `blocked` / `external_not_authorized` | 5 |
| No candidate | `blocked` / `media_unresolved` | 3 |
| Timeout (default 180 s) | `blocked` / `media_timeout` | 3 |
| Unparsable output | `failed` / `media_output_unparsed` | 3 |
| Missing / unreadable file | `failed` / `media_file_missing` or `audio_unreadable` | 4 |
| Path escapes the project | `failed` / `path_escape` | 4 |

A blocked BGM does not prevent SFX resolution, and vice versa; both are reported in `assets/media/prepare-report.json` and on stderr/stdout as structured JSON.

## Quality gates

- Every bound asset must exist, be non-empty, decode with `ffprobe`, and have a positive duration.
- The BGM is mastered to `audio.bgmMasterLufs` in `HBG_STYLE.json` (−26 LUFS) during ingest; `audio.bgmVolume` (0.15) then lands it about 18 dB below narration. A hot source cannot dominate the mix.
- The SFX is trimmed/looped to `narration.flashDuration` (default 1.667 s) with a 30 ms fade-out.
- The BGM path must still survive `build_composition.mjs`, which loops it to the full video duration at the style's fixed volume.
- `scripts/prepare_media.mjs --verify-only` is the pre-render gate.
- Existing gates (`validate_style_system.mjs`, `hyperframes check --strict`, `verify_final_video.sh`) are unchanged.

## Limitations

- Offline BGM has no bundled catalogue: `local-only` needs `mediaUse.bgm.from` or `.reuse`, otherwise it reports `blocked`.
- Bundled SFX exist for transitions and UI accents; a very specific request (for example a literal ratchet) may fall back to the closest transition cue, which is recorded explicitly.
- Semantic matching is the agent's responsibility; media-use only reuses exact-normalized matches.
- Provider catalogue use requires a user-controlled account and an explicitly authorized `production` run.
- Album/artist metadata is not extracted; license verification remains a human step.
- Images, icons, logos and voice are intentionally not wired into HBG's comic-image pipeline.
