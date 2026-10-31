# Project specification

Use `PROJECT_SPEC.json` for every value that changes with the story. Builders must never contain a story title, fixed chapter count, character identity, correction list, voice choice, BGM filename, flash-life list, or selected-life image path.

Required shape:

```json
{
  "version": 1,
  "title": "完整的人生副本名称",
  "titleLines": ["标题第一行", "标题第二行"],
  "source": {
    "openingSentence": "今天体验的人生副本是完整的人生副本名称。",
    "corrections": [{ "from": "明显错词", "to": "修正后" }],
    "chapters": [{ "title": "章节名", "cue": "本章在正文中唯一的开头短语" }]
  },
  "narration": {
    "voice": "zh-CN-YunjianNeural",
    "bodyRate": "+0%",
    "leadRate": "+0%",
    "revealRate": "+0%",
    "pitch": "+0Hz",
    "flashDuration": 1.667,
    "captionMaxChars": 18,
    "captionMinChars": 6,
    "captionMinDuration": 0.55
  },
  "imageGeneration": {
    "channel": "local-account-api",
    "consent": "explicit",
    "provider": "codex",
    "model": "gpt-image-2",
    "concurrency": 5
  },
  "opening": {
    "leadDisplayText": "今天体验的人生副本是……",
    "flashMedia": "assets/opening/flash.mp4",
    "flashSfx": "assets/audio/sfx/flash-sfx.m4a",
    "finalImage": "assets/opening/final.jpg",
    "flashLives": [{ "asset": "assets/opening/life-01.png", "label": "另一种人生" }]
  },
  "audio": {
    "bgmSource": "assets/audio/bgm/source.mp3",
    "bgmLooped": "assets/audio/bgm/looped.m4a",
    "narrationOutput": "assets/audio/narration.m4a"
  },
  "mediaUse": {
    "enabled": false,
    "mode": "local-only",
    "allowExternalProviders": false,
    "bgm": { "intent": "warm reflective life-story score, no vocals" },
    "sfx": { "intent": "rapid mechanical ratchet, short transition whoosh", "localFallbackCues": ["whoosh-cinematic", "riser", "impact-bass-1"] }
  }
}
```

Rules:

- Keep `SCRIPT_SOURCE.md` verbatim. Put only unmistakable transcription repairs in `source.corrections`.
- Use any reasonable chapter count. Builders derive headings, act labels, sub-compositions, and timing from the array length.
- Make each chapter cue unique and ordered after corrections.
- Keep character identity in `CHARACTERS.md`, not in this shared specification or a builder.
- Set `imageGeneration.channel` to `local-account-api`, `built-in-imagegen`, or `external-compatible-api`. Record `consent`, provider label, model, and concurrency only; never record an endpoint, key, token, Cookie, OAuth path, account identity, or contents of protected proxy files.
- Use `local-account-api` only after the Skill consent/readiness gate. Use `built-in-imagegen` after decline or unavailable entitlement. Keep API concurrency at 5 by default and never above 10.
- Keep orientation-dependent pixels in `HBG_STYLE.json`, never in `PROJECT_SPEC.json`.
- Keep semantic scene selection in `STORYBOARD_BASE.json`; code may validate it but must not invent example-specific beats.
- Use `captionMaxChars=18` as the usual landscape ceiling and `14` as the usual portrait ceiling. Generated splits must meet `captionMinChars`; only a complete original utterance may set the short-caption exception.
- Record missing punctuation before a spoken list or a broken source phrase in `source.corrections`. Do not use source line breaks as synthetic TTS pauses.
- Resolve every `opening.flashLives[].asset` to the exact orientation canvas before validation.
- Resolve or copy every configured asset into the project before composition building.

## media-use block

`mediaUse` is optional. When it is absent or `enabled` is not `true`, every existing project keeps its manual BGM/SFX workflow and `scripts/prepare_media.mjs` exits as `skipped`.

- `enabled`: opt-in switch for `scripts/prepare_media.mjs`.
- `mode`: `local-only` (default; no network providers) or `production`. `production` is refused unless `allowExternalProviders` is `true`, which only the user may set.
- `bgm.intent` / `sfx.intent`: natural-language material request. A user-provided file (`bgm.from`) or a cache SHA (`bgm.reuse`) bypasses provider search.
- `bgm.license` / `sfx.license` + `publishAllowed`: only an explicitly acknowledged license clears an asset for publication. Otherwise it is recorded as `LICENSE_UNVERIFIED` and is not publishable.
- `sfx.localFallbackCues`: bundled transition cues to try when an offline intent has no match.
- `sfx.normalizeDuration: false`: keep the raw SFX length instead of trimming/looping it to `narration.flashDuration`.
- Never record a provider endpoint, API key, OAuth record, account id, or user story text here.

`opening.flashSfx` is independent of `opening.flashMedia`: the flash video and its sound effect bind separately, and `audio_meta.opening.flash.video` / `.audio` must stay different when both are configured. Omitting `flashSfx` preserves the legacy single-path behaviour.
