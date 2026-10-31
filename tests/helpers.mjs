import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const scriptsDir = path.join(repoRoot, "scripts");
export const fakeCli = path.join(repoRoot, "tests", "fixtures", "fake_media_use.mjs");

export function makeTempDir(prefix = "hbg-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
    ...options,
  });
}

export function nodeScript(script, args = [], options = {}) {
  return run(process.execPath, [path.join(scriptsDir, script), ...args], options);
}

function ffmpegFailure(label, result) {
  const reason = result.error?.code ?? (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
  return new Error(`${label} failed: ${reason}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
}

export function makeTone(file, { seconds = 3, frequency = 330, format = "mp3" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const codec = format === "mp3" ? ["-c:a", "libmp3lame", "-b:a", "128k"] : ["-c:a", "aac", "-b:a", "192k"];
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:duration=${seconds}`,
    ...codec, file,
  ]);
  if (result.status !== 0) throw ffmpegFailure("ffmpeg tone", result);
  return file;
}

export function makeImage(file, { width = 192, height = 108, color = "0x334455" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const result = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:d=1`,
    "-frames:v", "1", file,
  ]);
  if (result.status !== 0) throw ffmpegFailure("ffmpeg image", result);
  return file;
}

export function makeProject(root, specOverrides = {}) {
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  const spec = {
    version: 1,
    title: "测试人生副本",
    titleLines: ["测试人生副本"],
    source: {
      openingSentence: "今天体验的人生副本是测试人生副本。",
      corrections: [],
      chapters: [{ title: "第一幕", cue: "这是测试" }],
    },
    narration: {
      voice: "zh-CN-YunjianNeural",
      bodyRate: "+0%",
      leadRate: "+0%",
      revealRate: "+0%",
      pitch: "+0Hz",
      flashDuration: 1.667,
      captionMaxChars: 18,
      captionMinChars: 6,
      captionMinDuration: 0.55,
    },
    imageGeneration: {
      channel: "built-in-imagegen",
      consent: "declined",
      provider: "openrouter",
      model: "test-model",
      concurrency: 5,
    },
    opening: {
      leadDisplayText: "今天体验的人生副本是……",
      flashMedia: "assets/opening/flash.mp4",
      finalImage: "assets/opening/final.png",
      flashLives: [{ asset: "assets/opening/life-01.png", label: "另一种人生" }],
    },
    audio: {
      bgmSource: "assets/audio/bgm/source.mp3",
      bgmLooped: "assets/audio/bgm/looped.m4a",
      narrationOutput: "assets/audio/narration.m4a",
    },
    ...specOverrides,
  };
  fs.writeFileSync(path.join(root, "PROJECT_SPEC.json"), `${JSON.stringify(spec, null, 2)}\n`);
  return spec;
}

export function readSpec(root) {
  return JSON.parse(fs.readFileSync(path.join(root, "PROJECT_SPEC.json"), "utf8"));
}

export function writeSpec(root, spec) {
  fs.writeFileSync(path.join(root, "PROJECT_SPEC.json"), `${JSON.stringify(spec, null, 2)}\n`);
}

export function fakeEnv(source, mode = "ok") {
  return {
    HBG_MEDIA_USE_CLI: JSON.stringify([process.execPath, fakeCli]),
    FAKE_MEDIA_MODE: mode,
    FAKE_MEDIA_SOURCE: source,
  };
}

export function probeDuration(file) {
  const result = run("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", file,
  ]);
  return Number(result.stdout.trim());
}

export function probeStreams(file) {
  const result = run("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,codec_name",
    "-of", "json", file,
  ]);
  return JSON.parse(result.stdout).streams ?? [];
}

export function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Build a tiny but structurally valid HBG project for composition/streaming
 * tests. All media is synthesized locally (sine tones and solid colour frames),
 * so no provider, account or third-party asset is involved.
 */
export function makeRenderFixture(root, { separateFlashSfx = true } = {}) {
  const flashMedia = "assets/opening/flash.mp4";
  const flashSfx = "assets/audio/sfx/flash-sfx.m4a";
  const spec = makeProject(root, {
    opening: {
      leadDisplayText: "今天体验的人生副本是……",
      flashMedia,
      ...(separateFlashSfx ? { flashSfx } : {}),
      finalImage: "assets/opening/final.png",
      flashLives: [{ asset: "assets/opening/life-01.png", label: "另一种人生" }],
    },
  });

  makeImage(path.join(root, "assets/opening/life-01.png"));
  makeImage(path.join(root, "assets/opening/final.png"));
  makeImage(path.join(root, "assets/generated/scenes/s001.png"));
  makeImage(path.join(root, "assets/generated/scenes/s002.png"));

  makeTone(path.join(root, "assets/audio/opening/lead.mp3"), { seconds: 1 });
  makeTone(path.join(root, "assets/audio/opening/reveal.mp3"), { seconds: 1 });
  makeTone(path.join(root, "assets/audio/narration.m4a"), { seconds: 2, format: "m4a" });
  makeTone(path.join(root, "assets/audio/bgm/source.mp3"), { seconds: 4 });
  makeTone(path.join(root, "assets/audio/sfx/flash-sfx.m4a"), { seconds: 1.667, format: "m4a" });
  if (!separateFlashSfx) {
    // Legacy shape: the flash audio path is the flash media path itself.
    makeTone(path.join(root, flashMedia), { seconds: 1.667, format: "m4a" });
  }

  const openingVideo = path.join(root, "qa/opening-approved.mp4");
  fs.mkdirSync(path.dirname(openingVideo), { recursive: true });
  const openingResult = run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=0x221a16:s=320x180:d=3",
    "-vf", "zoompan=z='1+0.1*on/60':d=90:s=320x180:fps=30",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", openingVideo,
  ]);
  if (openingResult.status !== 0) throw ffmpegFailure("opening video", openingResult);

  const storyboard = [
    { id: "s001", chapter: 1, cue: "这是测试", description: "第一幕测试画面", asset: "assets/generated/scenes/s001.png", motion: "zoom-in", start: 4, duration: 1, end: 5, highRisk: false },
    { id: "s002", chapter: 1, cue: "这是测试", description: "第二幕测试画面", asset: "assets/generated/scenes/s002.png", motion: "pan-right", start: 5, duration: 1, end: 6, highRisk: false },
  ];
  fs.writeFileSync(path.join(root, "STORYBOARD.json"), `${JSON.stringify(storyboard, null, 2)}\n`);

  const audioMeta = {
    provider: "test-fixture",
    voice: "test",
    rate: "+0%",
    pitch: "+0Hz",
    syncMode: "fixture",
    openingDuration: 4,
    opening: {
      previewVideo: "qa/opening-approved.mp4",
      lead: { text: "测试", path: "assets/audio/opening/lead.mp3", rate: "+0%", start: 0, duration: 1, end: 1 },
      flash: { video: flashMedia, audio: separateFlashSfx ? flashSfx : flashMedia, start: 1.1, duration: 1.667, end: 2.767 },
      reveal: { text: "测试", path: "assets/audio/opening/reveal.mp3", rate: "+0%", start: 2.9, duration: 1, end: 3.9 },
      bodyStart: 4,
    },
    body: { text: "测试", path: "assets/audio/narration.m4a", sourcePath: "assets/audio/narration.m4a", vtt: "assets/none.vtt", duration: 2 },
    bgm: { path: "assets/audio/bgm/looped.m4a" },
    chapters: [{ id: "ch01", chapter: 1, title: "第一幕", text: "这是测试", start: 4, end: 6, duration: 2 }],
    captions: [{ id: "caption-0001", start: 0, end: 1.5, duration: 1.5, text: "这是测试", allowShort: false }],
    narrationDuration: 2,
    totalDuration: 6,
  };
  fs.writeFileSync(path.join(root, "audio_meta.json"), `${JSON.stringify(audioMeta, null, 2)}\n`);

  const styleResult = nodeScript("init_project_style.mjs", [root]);
  if (styleResult.status !== 0) throw new Error(`style init failed: ${styleResult.stderr}`);
  return { spec, audioMeta, flashMedia, flashSfx };
}

