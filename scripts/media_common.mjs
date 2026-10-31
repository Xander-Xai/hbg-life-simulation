import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

export const SUPPORTED_TYPES = ["bgm", "sfx"];
export const DEFAULT_MEDIA_CLI = process.platform === "win32"
  ? ["npx.cmd", "--yes", "hyperframes", "media-use"]
  : ["npx", "--yes", "hyperframes", "media-use"];
export const LICENSED_UNVERIFIED = "LICENSE_UNVERIFIED";

export class MediaError extends Error {
  constructor(message, { code = "media_error", exitCode = 4, details = null } = {}) {
    super(message);
    this.name = "MediaError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const toPosix = (value) => value.split(path.sep).join("/");

export function sha256File(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

export function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export function atomicWriteFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
}

export function writeJsonAtomic(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function assertInside(root, target, label = "path") {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MediaError(`${label} escapes the project directory: ${target}`, {
      code: "path_escape",
      exitCode: 4,
    });
  }
  return resolved;
}

export function fileIsNonEmpty(file) {
  try {
    return fs.statSync(file).isFile() && fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function probeAudio(file) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,channels,sample_rate:format=duration,format_name",
    "-of", "json",
    file,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MediaError(`ffprobe could not read audio: ${path.basename(file)}`, {
      code: "audio_unreadable",
      exitCode: 4,
      details: result.stderr?.trim() ?? null,
    });
  }
  const probed = JSON.parse(result.stdout);
  const stream = probed.streams?.[0];
  const duration = Number(probed.format?.duration);
  if (!stream) {
    throw new MediaError(`no audio stream in ${path.basename(file)}`, {
      code: "audio_stream_missing",
      exitCode: 4,
    });
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaError(`invalid audio duration in ${path.basename(file)}: ${probed.format?.duration}`, {
      code: "audio_duration_invalid",
      exitCode: 4,
    });
  }
  return {
    duration,
    codec: stream.codec_name ?? null,
    channels: Number(stream.channels ?? 0),
    sampleRate: Number(stream.sample_rate ?? 0),
    format: probed.format?.format_name ?? null,
  };
}

export function validateAudioAsset(file, { label = "audio" } = {}) {
  if (!fileIsNonEmpty(file)) {
    throw new MediaError(`${label} is missing or empty: ${file}`, {
      code: "audio_missing",
      exitCode: 4,
    });
  }
  return probeAudio(file);
}

export function findNpxCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function resolveMediaCommand() {
  const override = process.env.HBG_MEDIA_USE_CLI;
  if (override) {
    const trimmed = override.trim();
    if (trimmed.startsWith("[")) {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string")) {
        throw new MediaError("HBG_MEDIA_USE_CLI must be a JSON array of strings", { code: "media_cli_invalid", exitCode: 2 });
      }
      return parsed;
    }
    return [trimmed];
  }
  const npxCli = findNpxCli();
  if (npxCli) return [process.execPath, npxCli, "--yes", "hyperframes", "media-use"];
  return [...DEFAULT_MEDIA_CLI];
}

export function buildMediaUseArgs({ type, intent, project, to, reuse, localOnly, json = true }) {
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new MediaError(`unsupported media type: ${type} (expected ${SUPPORTED_TYPES.join(" or ")})`, {
      code: "unsupported_type",
      exitCode: 2,
    });
  }
  const args = ["resolve", "--type", type, "--project", project];
  if (intent) args.push("--intent", intent);
  if (to) args.push("--from", to);
  if (reuse) args.push("--reuse", reuse);
  if (localOnly) args.push("--local-only");
  if (json) args.push("--json");
  return args;
}

export function parseResolveOutput(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) throw new MediaError("media-use returned empty output", { code: "media_output_empty", exitCode: 3 });
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return { data: parsed, format: "json" };
    } catch {
      // keep scanning; a provider may print non-JSON noise before the payload
    }
  }
  const match = text.match(/^resolved\s+(\S+)\s*(?:→|->)\s*(.+?)\s*\(([a-z]+)(?:,\s*([^)]*))?\)\s*$/u);
  if (match) {
    const [, id, mediaPath, type, metadata = ""] = match;
    const durationMatch = metadata.match(/([\d.]+)\s*s/);
    return {
      format: "line",
      data: {
        ok: true,
        id,
        type,
        path: mediaPath,
        duration: durationMatch ? Number(durationMatch[1]) : null,
        metadata,
      },
    };
  }
  throw new MediaError("media-use output is neither JSON nor a documented resolve line", {
    code: "media_output_unparsed",
    exitCode: 3,
    details: text.split(/\r?\n/).slice(0, 5).join("\n"),
  });
}

export function runMediaUse({ command, args, cwd, timeoutMs = 180000 }) {
  const execute = (parts) => {
    const [bin, ...prefix] = parts;
    return spawnSync(bin, [...prefix, ...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  };
  let [bin, ...prefix] = command;
  let result = execute([bin, ...prefix]);
  // Windows resolves .cmd shims only when the extension is explicit.
  if (result.error?.code === "ENOENT" && process.platform === "win32" && !/\.(cmd|exe|bat)$/i.test(bin)) {
    result = execute([`${bin}.cmd`, ...prefix]);
  }
  if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM") {
    const error = new MediaError(`media-use timed out after ${timeoutMs}ms`, { code: "media_timeout", exitCode: 3 });
    error.status = null;
    error.stdout = result.stdout ?? "";
    error.stderr = result.stderr ?? "";
    throw error;
  }
  if (result.error?.code === "ENOENT") {
    const error = new MediaError("media-use CLI is not available in this environment", {
      code: "media_cli_missing",
      exitCode: 5,
    });
    error.status = null;
    error.stdout = result.stdout ?? "";
    error.stderr = result.stderr ?? "";
    throw error;
  }
  if (result.error?.code === "EINVAL") {
    const error = new MediaError(
      "media-use CLI could not be spawned; on Windows, .cmd shims cannot be executed directly. Point HBG_MEDIA_USE_CLI at a .js/.exe entry or a JSON command array.",
      { code: "media_cli_not_spawnable", exitCode: 5 },
    );
    error.status = null;
    error.stdout = result.stdout ?? "";
    error.stderr = result.stderr ?? "";
    throw error;
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function classifyMediaFailure({ status, stdout, stderr }) {
  const output = `${stdout}\n${stderr}`;
  const normalized = output.toLowerCase();
  if (/no provider could resolve|no reusable global asset|could not resolve|candidates found|not found/.test(normalized)) {
    return { code: "media_unresolved", exitCode: 3, message: "no media provider could satisfy the request" };
  }
  if (/auth|login|unauthori[sz]ed|forbidden|401|403|credential/.test(normalized)) {
    return {
      code: "provider_auth_required",
      exitCode: 5,
      message: "an external provider requires account sign-in; this run must not log in automatically",
    };
  }
  if (/network|enotfound|econnrefused|fetch failed|timed? ?out/.test(normalized)) {
    return { code: "provider_network_unavailable", exitCode: 3, message: "network provider is unavailable" };
  }
  return { code: "media_failed", exitCode: 3, message: `media-use exited with status ${status}` };
}

export function projectMediaIndexPath(root) {
  return path.join(root, "assets", "media", "hbg-media-index.json");
}

export function readMediaIndex(root) {
  const file = projectMediaIndexPath(root);
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  const value = readJson(file);
  if (!Array.isArray(value.entries)) return { version: 1, entries: [] };
  return value;
}

export function writeMediaIndex(root, index) {
  writeJsonAtomic(projectMediaIndexPath(root), index);
}

export function findIndexEntry(index, { type, intent, intentHash }) {
  return index.entries.find((entry) => {
    if (entry.type !== type) return false;
    if (intentHash && entry.intentHash === intentHash) return true;
    return Boolean(intent) && entry.intent === intent;
  }) ?? null;
}

export function indexEntryIsUsable(root, entry) {
  if (!entry?.localPath) return false;
  let absolute;
  try {
    absolute = assertInside(root, entry.localPath, "indexed asset");
  } catch {
    return false;
  }
  if (!fileIsNonEmpty(absolute)) return false;
  if (!entry.sha256) return false;
  try {
    return sha256File(absolute) === entry.sha256;
  } catch {
    return false;
  }
}

export function recordIndexEntry(root, entry) {
  const index = readMediaIndex(root);
  const existing = index.entries.findIndex((item) => item.localPath === entry.localPath);
  if (existing >= 0) index.entries[existing] = { ...index.entries[existing], ...entry, updatedAt: new Date().toISOString() };
  else index.entries.push({ ...entry, recordedAt: new Date().toISOString() });
  writeMediaIndex(root, index);
  return index;
}

export function copyIntoProject({ root, source, relativeTarget }) {
  const target = assertInside(root, relativeTarget, "media target");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const sourceHash = sha256File(source);
  if (fileIsNonEmpty(target)) {
    const targetHash = sha256File(target);
    if (targetHash === sourceHash) return { target, sha256: sourceHash, copied: false };
    const ext = path.extname(relativeTarget);
    const stem = relativeTarget.slice(0, -ext.length);
    return copyIntoProject({
      root,
      source,
      relativeTarget: `${stem}-${sourceHash.slice(0, 8)}${ext}`,
    });
  }
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, target);
  return { target, sha256: sourceHash, copied: true };
}

export function normalizeLoudness({ source, target, targetLufs = -26, targetPeak = -6, lra = 6 }) {
  const lufs = Number(targetLufs);
  if (!Number.isFinite(lufs)) {
    throw new MediaError(`loudness target must be a number: ${targetLufs}`, { code: "loudness_invalid", exitCode: 2 });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source,
    "-af", `loudnorm=I=${lufs}:TP=${targetPeak}:LRA=${lra}`,
    "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k", target,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MediaError("ffmpeg could not normalise the media loudness", {
      code: "loudness_normalize_failed",
      exitCode: 4,
      details: result.stderr?.trim() ?? null,
    });
  }
  return { target, sha256: sha256File(target), targetLufs: lufs, targetPeak };
}

export function measureLoudness(file) {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-nostats", "-i", file, "-vn",
    "-af", "ebur128=peak=true", "-f", "null", "-",
  ], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const output = `${result.stdout}\n${result.stderr}`;
  const integrated = output.match(/Integrated loudness:[\s\S]*?I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  const peak = output.match(/True peak:[\s\S]*?Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    truePeakDbfs: peak ? Number(peak[1]) : null,
  };
}

export function normalizeAudioDuration({ source, target, seconds, fadeOut = 0.03 }) {  const duration = Number(seconds);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new MediaError(`normalize duration must be positive: ${seconds}`, { code: "normalize_invalid", exitCode: 2 });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fadeStart = Math.max(0, duration - fadeOut);
  const filters = [`atrim=0:${duration}`, `afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOut}`];
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-stream_loop", "-1", "-i", source,
    "-t", String(duration),
    "-af", filters.join(","),
    "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
    target,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MediaError("ffmpeg could not normalize the media duration", {
      code: "normalize_failed",
      exitCode: 4,
      details: result.stderr?.trim() ?? null,
    });
  }
  return { target, sha256: sha256File(target), duration };
}

export function defaultLicenseFor(provenance) {
  const provider = String(provenance?.provider ?? "").toLowerCase();
  if (provider.startsWith("bundled")) return { license: LICENSED_UNVERIFIED, publishAllowed: false, note: "bundled library asset; license not verified for commercial release" };
  if (provider === "local") return { license: LICENSED_UNVERIFIED, publishAllowed: false, note: "user-provided file; license not verified" };
  return { license: LICENSED_UNVERIFIED, publishAllowed: false, note: "provider license not verified" };
}

export function bindingFor(spec, type) {
  if (type === "bgm") return spec.audio?.bgmSource ?? null;
  if (type === "sfx") return spec.opening?.flashSfx ?? null;
  return null;
}

export function setBinding(spec, type, relative) {
  if (type === "bgm") {
    spec.audio ??= {};
    spec.audio.bgmSource = relative;
    return spec;
  }
  if (type === "sfx") {
    spec.opening ??= {};
    spec.opening.flashSfx = relative;
    return spec;
  }
  throw new MediaError(`unsupported media type: ${type}`, { code: "unsupported_type", exitCode: 2 });
}

export function validateBinding(root, type, relative, { allowMissing = false } = {}) {
  if (!relative) return { valid: false, reason: "unbound" };
  try {
    const absolute = assertInside(root, relative, `${type} binding`);
    if (!fileIsNonEmpty(absolute)) return { valid: false, reason: "missing" };
    const probe = probeAudio(absolute);
    return { valid: true, absolute, probe };
  } catch (error) {
    if (allowMissing) return { valid: false, reason: error.message };
    throw error;
  }
}

export function canonicalTarget(type, id, extension) {
  const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, "_");
  const safeExt = extension && extension !== "." ? extension : ".mp3";
  if (type === "bgm") return `assets/audio/bgm/${safeId}${safeExt}`;
  if (type === "sfx") return `assets/audio/sfx/${safeId}${safeExt}`;
  throw new MediaError(`unsupported media type: ${type}`, { code: "unsupported_type", exitCode: 2 });
}
