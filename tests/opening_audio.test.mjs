import test from "node:test";
import assert from "node:assert/strict";
import { resolveFlashTracks } from "../scripts/opening_audio.mjs";

test("T10: legacy projects keep one path for flash video and audio", () => {
  const spec = { opening: { flashMedia: "assets/opening/flash.mp4" } };
  assert.deepEqual(resolveFlashTracks(spec), {
    video: "assets/opening/flash.mp4",
    audio: "assets/opening/flash.mp4",
  });
});

test("T09: an explicit flashSfx decouples the audio track", () => {
  const spec = {
    opening: { flashMedia: "assets/opening/flash.mp4", flashSfx: "assets/audio/sfx/flash.m4a" },
  };
  assert.deepEqual(resolveFlashTracks(spec), {
    video: "assets/opening/flash.mp4",
    audio: "assets/audio/sfx/flash.m4a",
  });
});

test("missing flashMedia is a hard error", () => {
  assert.throws(() => resolveFlashTracks({ opening: {} }), /flashMedia is required/);
});
