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
  probeDuration,
  readSpec,
  listFiles,
} from "./helpers.mjs";

function projectWithMediaUse(extra = {}) {
  const root = makeTempDir();
  const source = makeTone(path.join(root, "assets/source-tone.mp3"), { seconds: 4 });
  makeProject(root, {
    mediaUse: { enabled: true, mode: "local-only", ...extra },
  });
  return { root, source };
}

function resolve(root, args, env, extra = {}) {
  return nodeScript("resolve_media.mjs", ["--project", root, "--json", ...args], {
    env: { ...process.env, ...env },
    ...extra,
  });
}

test("T01/T03: resolves BGM through media-use, copies it and updates PROJECT_SPEC", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(root, ["--type", "bgm", "--intent", "warm piano"], fakeEnv(source));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "resolved");
  assert.equal(payload.type, "bgm");
  assert.equal(payload.provider, "fake.local");
  assert.equal(payload.license, "LICENSE_UNVERIFIED");
  assert.equal(payload.publishAllowed, false);

  const spec = readSpec(root);
  assert.equal(spec.audio.bgmSource, payload.path);
  const bound = path.join(root, payload.path);
  assert.ok(fs.existsSync(bound));
  assert.ok(fs.statSync(bound).size > 0);

  const index = JSON.parse(fs.readFileSync(path.join(root, "assets/media/hbg-media-index.json"), "utf8"));
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0].sha256, payload.sha256);
  assert.equal(index.entries[0].license, "LICENSE_UNVERIFIED");
  assert.equal(index.entries[0].publishAllowed, false);
});

test("T04/T19: a second identical run reuses the binding and writes no new files", () => {
  const { root, source } = projectWithMediaUse();
  const env = fakeEnv(source);
  const first = resolve(root, ["--type", "bgm", "--intent", "warm piano"], env);
  assert.equal(first.status, 0, first.stdout);
  const before = listFiles(root);

  const second = resolve(root, ["--type", "bgm", "--intent", "warm piano"], env);
  assert.equal(second.status, 0, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, "reused-binding");
  assert.deepEqual(listFiles(root), before);
});

test("T05: cache hit works when the CLI is unavailable", () => {
  const { root, source } = projectWithMediaUse();
  const first = resolve(root, ["--type", "bgm", "--intent", "warm piano"], fakeEnv(source));
  assert.equal(first.status, 0);
  const resolvedPath = JSON.parse(first.stdout).path;
  const spec = readSpec(root);
  delete spec.audio.bgmSource;
  fs.writeFileSync(path.join(root, "PROJECT_SPEC.json"), JSON.stringify(spec, null, 2));

  // The fake CLI would exit 1 in this mode; a cache hit must not call it.
  const second = resolve(root, ["--type", "bgm", "--intent", "warm piano"], fakeEnv(source, "unresolved"));
  assert.equal(second.status, 0, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.status, "reused-cache");
  assert.equal(payload.path, resolvedPath);
  assert.equal(readSpec(root).audio.bgmSource, resolvedPath);
});

test("T07: an unreadable or missing provider file is rejected", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(root, ["--type", "bgm", "--intent", "x"], fakeEnv(source, "missing-file"));
  assert.equal(result.status, 4, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "failed");
  assert.equal(payload.code, "media_file_missing");
  assert.equal(readSpec(root).audio.bgmSource, "assets/audio/bgm/source.mp3");
});

test("T12: a resolved path that escapes the project is refused", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(root, ["--type", "bgm", "--intent", "x"], fakeEnv(source, "escape"));
  assert.equal(result.status, 4, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.code, "path_escape");
});

test("T11: provider failure and auth requirements map to bounded exit codes", () => {
  const { root, source } = projectWithMediaUse();
  const unresolved = resolve(root, ["--type", "bgm", "--intent", "x"], fakeEnv(source, "unresolved"));
  assert.equal(unresolved.status, 3);
  assert.equal(JSON.parse(unresolved.stdout).status, "blocked");

  const auth = resolve(root, ["--type", "bgm", "--intent", "x"], fakeEnv(source, "auth"));
  assert.equal(auth.status, 5);
  const payload = JSON.parse(auth.stdout);
  assert.equal(payload.code, "provider_auth_required");
  assert.equal(payload.status, "blocked");
});

test("T11b: a hung provider is killed at the configured timeout", () => {
  const { root, source } = projectWithMediaUse();
  const started = Date.now();
  const result = resolve(root, ["--type", "bgm", "--intent", "x", "--timeout-ms", "800"], fakeEnv(source, "timeout"));
  const elapsed = Date.now() - started;
  assert.equal(result.status, 3, result.stdout);
  assert.equal(JSON.parse(result.stdout).code, "media_timeout");
  assert.ok(elapsed < 20000, `timeout was not bounded: ${elapsed}ms`);
});

test("T15: unparsable provider output fails explicitly", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(root, ["--type", "bgm", "--intent", "x"], fakeEnv(source, "invalid-json"));
  assert.equal(result.status, 3, result.stdout);
  assert.equal(JSON.parse(result.stdout).code, "media_output_unparsed");
});

test("T06: production mode refuses to contact providers without explicit authorization", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(root, ["--type", "bgm", "--intent", "x", "--mode", "production"], fakeEnv(source));
  assert.equal(result.status, 5, result.stdout);
  assert.equal(JSON.parse(result.stdout).code, "external_not_authorized");
});

test("T14: publishAllowed stays false while the license is unverified", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(
    root,
    ["--type", "bgm", "--intent", "x", "--publish-allowed"],
    fakeEnv(source),
  );
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.license, "LICENSE_UNVERIFIED");
  assert.equal(payload.publishAllowed, false);

  const index = JSON.parse(fs.readFileSync(path.join(root, "assets/media/hbg-media-index.json"), "utf8"));
  assert.equal(index.entries[0].publishAllowed, false);
});

test("explicit license makes publication eligibility possible", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(
    root,
    ["--type", "bgm", "--intent", "x", "--license", "CC0-1.0", "--publish-allowed"],
    fakeEnv(source),
  );
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.license, "CC0-1.0");
  assert.equal(payload.publishAllowed, true);
});

test("T09/T10: SFX normalizes to the requested flash duration", () => {
  const { root, source } = projectWithMediaUse();
  const result = resolve(
    root,
    ["--type", "sfx", "--intent", "whoosh", "--normalize-duration", "1.667"],
    fakeEnv(source),
  );
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "resolved-normalized");
  assert.equal(payload.preparedFrom, "assets/audio/sfx/sfx_001.mp3");
  const duration = probeDuration(path.join(root, payload.path));
  assert.ok(Math.abs(duration - 1.667) < 0.06, `duration ${duration}`);
  assert.equal(readSpec(root).opening.flashSfx, payload.path);
});

test("unsupported types and missing intents are usage errors", () => {
  const { root, source } = projectWithMediaUse();
  const badType = resolve(root, ["--type", "video", "--intent", "x"], fakeEnv(source));
  assert.equal(badType.status, 2);
  assert.equal(JSON.parse(badType.stdout).code, "unsupported_type");

  const noIntent = resolve(root, ["--type", "bgm"], fakeEnv(source));
  assert.equal(noIntent.status, 2);
  assert.equal(JSON.parse(noIntent.stdout).code, "usage");
});

test("T13: re-resolving the same content deduplicates instead of duplicating", () => {
  const { root, source } = projectWithMediaUse();
  const env = fakeEnv(source);
  const first = resolve(root, ["--type", "bgm", "--intent", "warm piano"], env);
  assert.equal(first.status, 0, first.stdout);
  const second = resolve(root, ["--type", "bgm", "--intent", "warm piano", "--force"], env);
  assert.equal(second.status, 0, second.stdout);
  const payload = JSON.parse(second.stdout);
  assert.equal(payload.copied, false);
  assert.equal(payload.sha256, JSON.parse(first.stdout).sha256);
  const bgmFiles = listFiles(root).filter((file) => file.startsWith("assets/audio/bgm/") && file.endsWith(".mp3"));
  assert.equal(bgmFiles.length, 1, `unexpected duplicate files: ${bgmFiles.join(", ")}`);
});

test("dry run makes no provider call and changes nothing", () => {
  const { root, source } = projectWithMediaUse();
  const before = listFiles(root);
  const result = resolve(root, ["--type", "bgm", "--intent", "x", "--dry-run"], fakeEnv(source, "unresolved"));
  assert.equal(result.status, 0, result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "planned");
  assert.ok(Array.isArray(payload.command) && payload.command.includes("resolve"));
  assert.deepEqual(listFiles(root), before);
});
