import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  makeRenderFixture,
  makeTempDir,
  nodeScript,
  probeDuration,
  probeStreams,
} from "./helpers.mjs";

test("T16: composition binds the independent flash SFX and rebuilds the looped BGM", () => {
  const root = makeTempDir();
  const { flashSfx } = makeRenderFixture(root, { separateFlashSfx: true });
  const result = nodeScript("build_composition.mjs", [], { cwd: root });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.includes(`id="audio-opening-ratchet" src="${flashSfx}"`), "flash SFX must be the ratchet source");
  assert.ok(html.includes('id="audio-bgm" src="assets/audio/bgm/looped.m4a"'));
  assert.ok(fs.existsSync(path.join(root, "compositions/ch01.html")));
  assert.ok(fs.existsSync(path.join(root, "qa/opening-bgm-preview.html")));

  const looped = path.join(root, "assets/audio/bgm/looped.m4a");
  assert.ok(fs.existsSync(looped));
  const duration = probeDuration(looped);
  assert.ok(Math.abs(duration - 6) < 0.3, `looped BGM duration ${duration}`);

  const output = JSON.parse(result.stdout);
  assert.equal(output.scenes, 2);
  assert.equal(output.chapters, 1);
});

test("T10: legacy projects without flashSfx keep the original single-path behaviour", () => {
  const root = makeTempDir();
  const { flashMedia } = makeRenderFixture(root, { separateFlashSfx: false });
  const result = nodeScript("build_composition.mjs", [], { cwd: root });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  assert.ok(html.includes(`id="audio-opening-ratchet" src="${flashMedia}"`));
});

test("T17/T18: streaming render resolves the separate SFX and produces playable audio", () => {
  const root = makeTempDir();
  makeRenderFixture(root, { separateFlashSfx: true });
  // flashMedia is deliberately absent in this fixture: a render that still
  // reused it as audio would fail instead of silently passing.
  assert.equal(fs.existsSync(path.join(root, "assets/opening/flash.mp4")), false);

  // The looped BGM track is produced by the composition builder, as in the real flow.
  const composition = nodeScript("build_composition.mjs", [], { cwd: root });
  assert.equal(composition.status, 0, composition.stdout + composition.stderr);

  const result = nodeScript("render_streaming_ffmpeg.mjs", [root, "renders/stream-test.mp4"], {
    cwd: root,
    timeout: 240000,
    env: {
      ...process.env,
      HBG_SKIP_STYLE_VALIDATION: "1",
      HBG_WIDTH: "320",
      HBG_HEIGHT: "180",
      HBG_FPS: "10",
    },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const output = path.join(root, "renders/stream-test.mp4");
  assert.ok(fs.existsSync(output));
  const streams = probeStreams(output);
  assert.ok(streams.some((stream) => stream.codec_type === "video"));
  assert.ok(streams.some((stream) => stream.codec_type === "audio"));
  const duration = probeDuration(output);
  assert.ok(Math.abs(duration - 6) < 0.5, `render duration ${duration}`);
});
