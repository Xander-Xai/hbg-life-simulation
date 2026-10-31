import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  fakeEnv,
  makeProject,
  makeTempDir,
  makeTone,
  nodeScript,
  readSpec,
  writeSpec,
  listFiles,
} from "./helpers.mjs";

function prepare(root, args, env = {}) {
  return nodeScript("prepare_media.mjs", ["--project", root, "--json", ...args], {
    env: { ...process.env, ...env },
  });
}

function enabledProject(overrides = {}) {
  const root = makeTempDir();
  const source = makeTone(path.join(root, "assets/source-tone.mp3"), { seconds: 4 });
  makeProject(root, {
    mediaUse: {
      enabled: true,
      mode: "local-only",
      bgm: { intent: "warm reflective" },
      sfx: { intent: "mechanical ratchet" },
      ...overrides,
    },
  });
  return { root, source };
}

test("legacy projects are untouched when mediaUse is absent", () => {
  const root = makeTempDir();
  makeTone(path.join(root, "assets/source-tone.mp3"), { seconds: 2 });
  makeProject(root, {});
  const before = listFiles(root);
  const result = prepare(root, [], { HBG_MEDIA_USE_CLI: "[]" });
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "skipped");
  assert.deepEqual(listFiles(root), before);
  assert.equal(readSpec(root).audio.bgmSource, "assets/audio/bgm/source.mp3");
});

test("T03/T09: enabled projects resolve BGM and a decoupled flash SFX", () => {
  const { root, source } = enabledProject();
  const result = prepare(root, [], fakeEnv(source));
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "prepared");
  const types = payload.results.map((item) => item.type).sort();
  assert.deepEqual(types, ["bgm", "sfx"]);

  const spec = readSpec(root);
  assert.match(spec.audio.bgmSource, /assets\/audio\/bgm\//);
  assert.match(spec.audio.bgmSource, /master-26lufs\.m4a$/);
  assert.match(spec.opening.flashSfx, /assets\/audio\/sfx\//);
  assert.notEqual(spec.opening.flashSfx, spec.opening.flashMedia);
  assert.ok(fs.existsSync(path.join(root, spec.audio.bgmSource)));
  assert.ok(fs.existsSync(path.join(root, spec.opening.flashSfx)));

  const report = JSON.parse(fs.readFileSync(path.join(root, "assets/media/prepare-report.json"), "utf8"));
  assert.equal(report.bindings.bgm.valid, true);
  assert.equal(report.bindings.sfx.valid, true);
  assert.equal(report.bindings.bgm.license, "LICENSE_UNVERIFIED");
});

test("T04/T19: repeated preparation is idempotent", () => {
  const { root, source } = enabledProject();
  const env = fakeEnv(source);
  assert.equal(prepare(root, [], env).status, 0);
  const before = listFiles(root).filter((file) => !file.endsWith("prepare-report.json"));
  const second = prepare(root, [], env);
  assert.equal(second.status, 0, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.ok(payload.results.every((item) => item.status === "reused-binding"));
  const after = listFiles(root).filter((file) => !file.endsWith("prepare-report.json"));
  assert.deepEqual(after, before);
});

test("a local file can be ingested as BGM without any network provider", () => {
  const { root, source } = enabledProject();
  const local = path.join(root, "assets/audio/bgm/user-pick.mp3");
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.copyFileSync(source, local);
  const spec = readSpec(root);
  spec.mediaUse.bgm.from = "assets/audio/bgm/user-pick.mp3";
  spec.mediaUse.sfx.from = local; // wrong type on purpose: still a local ingest
  writeSpec(root, spec);

  const result = prepare(root, [], fakeEnv(source));
  // Both BGM and SFX ingest from local files, so no provider is needed.
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.ok(payload.results.every((item) => ["resolved", "resolved-normalized", "resolved-mastered"].includes(item.status)));
  assert.match(readSpec(root).audio.bgmSource, /bgm_001/);
});

test("SFX falls back to a bundled transition cue and records why", () => {
  const root = makeTempDir();
  const source = makeTone(path.join(root, "assets/source-tone.mp3"), { seconds: 2 });
  makeProject(root, {
    mediaUse: {
      enabled: true,
      mode: "local-only",
      bgm: {},
      sfx: { intent: "mechanical ratchet", localFallbackCues: ["whoosh-cinematic"] },
    },
  });
  const spec = readSpec(root);
  spec.audio.bgmSource = "";
  writeSpec(root, spec);

  const env = { ...fakeEnv(source), FAKE_MEDIA_FAIL_INTENT: "mechanical ratchet" };
  const result = prepare(root, ["--skip-bgm"], env);
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  const sfx = payload.results.find((item) => item.type === "sfx");
  assert.equal(sfx.status, "resolved-fallback");
  assert.equal(sfx.fallbackCue, "whoosh-cinematic");
  assert.equal(sfx.requestedIntent, "mechanical ratchet");

  const index = JSON.parse(fs.readFileSync(path.join(root, "assets/media/hbg-media-index.json"), "utf8"));
  const entry = index.entries.find((item) => item.type === "sfx");
  assert.equal(entry.resolvedVia, "local-fallback-cue");
  assert.equal(entry.fallbackCue, "whoosh-cinematic");
});

test("a blocked BGM does not prevent SFX resolution and is reported honestly", () => {
  const { root, source } = enabledProject();
  const env = { ...fakeEnv(source), FAKE_MEDIA_FAIL_INTENT: "warm reflective" };
  const result = prepare(root, [], env);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout);
  const bgm = payload.results.find((item) => item.type === "bgm");
  const sfx = payload.results.find((item) => item.type === "sfx");
  assert.equal(bgm.status, "failed");
  assert.ok(["resolved", "resolved-normalized", "resolved-fallback"].includes(sfx.status));
  assert.equal(readSpec(root).audio.bgmSource, "assets/audio/bgm/source.mp3");
});

test("verify-only reports invalid bindings without resolving", () => {
  const { root } = enabledProject();
  const result = prepare(root, ["--verify-only"], {});
  assert.equal(result.status, 3, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "verification_failed");
  assert.equal(payload.bgm.valid, false);
  assert.equal(payload.sfx.valid, false);
});

test("--enable opts a legacy project in without touching existing bindings", () => {
  const root = makeTempDir();
  const source = makeTone(path.join(root, "assets/source-tone.mp3"), { seconds: 2 });
  makeProject(root, {});
  const result = prepare(root, ["--enable"], fakeEnv(source));
  assert.equal(result.status, 0, result.stdout);
  assert.equal(readSpec(root).mediaUse.enabled, true);
});
