import fs from "node:fs";
import path from "node:path";
import {
  MediaError,
  LICENSED_UNVERIFIED,
  readJson,
  recordIndexEntry,
  writeJsonAtomic,
  sha256File,
  toPosix,
  validateBinding,
} from "./media_common.mjs";
import { resolveProjectMedia } from "./resolve_media.mjs";

const DEFAULT_BGM_INTENT = "warm reflective Chinese life-story background music, restrained, no vocals";
const DEFAULT_SFX_INTENT = "rapid mechanical ratchet, short cinematic whoosh, fast life selection transition";

function parseArgs(argv) {
  const options = {
    project: process.cwd(),
    mode: null,
    enable: false,
    dryRun: false,
    json: false,
    verifyOnly: false,
    skipBgm: false,
    skipSfx: false,
    force: false,
    timeoutMs: 180000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new MediaError(`unexpected argument: ${token}`, { code: "usage", exitCode: 2 });
    const [name, inline] = token.slice(2).split("=", 2);
    if (["enable", "dry-run", "json", "verify-only", "skip-bgm", "skip-sfx", "force"].includes(name)) {
      if (inline !== undefined) throw new MediaError(`--${name} does not take a value`, { code: "usage", exitCode: 2 });
      if (name === "enable") options.enable = true;
      if (name === "dry-run") options.dryRun = true;
      if (name === "json") options.json = true;
      if (name === "verify-only") options.verifyOnly = true;
      if (name === "skip-bgm") options.skipBgm = true;
      if (name === "skip-sfx") options.skipSfx = true;
      if (name === "force") options.force = true;
      continue;
    }
    if (!["project", "mode", "timeout-ms"].includes(name)) {
      throw new MediaError(`unknown option: --${name}`, { code: "usage", exitCode: 2 });
    }
    const value = inline !== undefined ? inline : argv[++index];
    if (value === undefined) throw new MediaError(`--${name} requires a value`, { code: "usage", exitCode: 2 });
    if (name === "project") options.project = value;
    if (name === "mode") options.mode = value;
    if (name === "timeout-ms") options.timeoutMs = Number(value);
  }
  return options;
}

function loadSpec(root) {
  const file = path.join(root, "PROJECT_SPEC.json");
  if (!fs.existsSync(file)) throw new MediaError(`PROJECT_SPEC.json not found in ${root}`, { code: "spec_missing", exitCode: 2 });
  return readJson(file);
}

function writeSpec(root, spec) {
  writeJsonAtomic(path.join(root, "PROJECT_SPEC.json"), spec);
}

export function mediaSettings(spec) {
  const mediaUse = spec.mediaUse ?? {};
  return {
    enabled: mediaUse.enabled === true,
    mode: mediaUse.mode === "production" ? "production" : "local-only",
    allowExternalProviders: mediaUse.allowExternalProviders === true,
    bgm: mediaUse.bgm ?? {},
    sfx: mediaUse.sfx ?? {},
  };
}

function flashDurationFor(spec) {
  const value = Number(spec.narration?.flashDuration ?? 1.667);
  return Number.isFinite(value) && value > 0 ? value : 1.667;
}

function reportPath(root) {
  return path.join(root, "assets", "media", "prepare-report.json");
}

function summarizeBinding(root, type, relative, license) {
  const binding = validateBinding(root, type, relative, { allowMissing: true });
  if (!binding.valid) {
    return { type, path: relative ?? null, valid: false, reason: binding.reason };
  }
  return {
    type,
    path: toPosix(path.relative(root, binding.absolute)),
    valid: true,
    sha256: sha256File(binding.absolute),
    duration: binding.probe.duration,
    bytes: fs.statSync(binding.absolute).size,
    license: license ?? LICENSED_UNVERIFIED,
    publishAllowed: false,
  };
}

export function prepareMedia({
  root,
  mode = null,
  enable = false,
  dryRun = false,
  verifyOnly = false,
  skipBgm = false,
  skipSfx = false,
  force = false,
  timeoutMs = 180000,
  command = null,
}) {
  const projectDir = path.resolve(root);
  let spec = loadSpec(projectDir);
  const settings = mediaSettings(spec);

  if (enable && spec.mediaUse?.enabled !== true) {
    spec.mediaUse = { ...(spec.mediaUse ?? {}), enabled: true };
    if (!dryRun) writeSpec(projectDir, spec);
  }
  const effectiveEnabled = enable || settings.enabled;
  if (!effectiveEnabled) {
    return {
      status: "skipped",
      reason: "PROJECT_SPEC.mediaUse.enabled is not true; legacy HBG behaviour preserved. Pass --enable to opt in.",
      projectDir,
      results: [],
    };
  }
  if (!settings.allowExternalProviders && (mode ?? settings.mode) === "production") {
    throw new MediaError(
      "production mode requires PROJECT_SPEC.mediaUse.allowExternalProviders=true; refusing to contact external providers",
      { code: "external_not_authorized", exitCode: 5 },
    );
  }
  const effectiveMode = mode ?? settings.mode;

  if (verifyOnly) {
    const bgm = summarizeBinding(projectDir, "bgm", spec.audio?.bgmSource, spec.mediaUse?.bgm?.license);
    const sfx = summarizeBinding(projectDir, "sfx", spec.opening?.flashSfx, spec.mediaUse?.sfx?.license);
    const ok = bgm.valid && sfx.valid;
    return { status: ok ? "verified" : "verification_failed", projectDir, mode: effectiveMode, bgm, sfx, results: [bgm, sfx] };
  }

  const results = [];

  if (!skipBgm) {
    const intendedIntent = settings.bgm.intent ?? DEFAULT_BGM_INTENT;
    const existing = validateBinding(projectDir, "bgm", spec.audio?.bgmSource, { allowMissing: true });
    if (existing.valid && !force) {
      results.push({ type: "bgm", status: "reused-binding", path: spec.audio.bgmSource, duration: existing.probe.duration });
    } else {
      try {
        const result = resolveProjectMedia({
          root: projectDir,
          type: "bgm",
          intent: intendedIntent,
          mode: effectiveMode,
          from: settings.bgm.from ? path.resolve(projectDir, settings.bgm.from) : null,
          reuse: settings.bgm.reuse ?? null,
          dryRun,
          force,
          replaceBinding: Boolean(spec.audio?.bgmSource) && !existing.valid,
          license: settings.bgm.license ?? null,
          publishAllowed: settings.bgm.publishAllowed === true,
          timeoutMs,
          command,
        });
        results.push(result);
      } catch (error) {
        if (!(error instanceof MediaError)) throw error;
        results.push({
          type: "bgm",
          status: error.exitCode === 5 ? "blocked" : "failed",
          code: error.code,
          reason: error.message,
          details: error.details ?? null,
          nextStep: "provide PROJECT_SPEC.mediaUse.bgm.from (a local file) or .reuse (a cache SHA), or run in production mode with an authorized provider",
        });
      }
    }
  }

  if (!skipSfx) {
    const intendedIntent = settings.sfx.intent ?? DEFAULT_SFX_INTENT;
    const existing = validateBinding(projectDir, "sfx", spec.opening?.flashSfx, { allowMissing: true });
    if (existing.valid && !force) {
      results.push({ type: "sfx", status: "reused-binding", path: spec.opening.flashSfx, duration: existing.probe.duration });
    } else {
      const normalize = settings.sfx.normalizeDuration === false ? null : flashDurationFor(spec);
      const base = {
        root: projectDir,
        type: "sfx",
        mode: effectiveMode,
        from: settings.sfx.from ? path.resolve(projectDir, settings.sfx.from) : null,
        reuse: settings.sfx.reuse ?? null,
        dryRun,
        force,
        replaceBinding: Boolean(spec.opening?.flashSfx) && !existing.valid,
        normalizeDuration: normalize,
        license: settings.sfx.license ?? null,
        publishAllowed: settings.sfx.publishAllowed === true,
        timeoutMs,
        command,
      };
      const fallbackCues = Array.isArray(settings.sfx.localFallbackCues)
        ? settings.sfx.localFallbackCues.filter((cue) => typeof cue === "string" && cue.trim())
        : ["whoosh-cinematic", "riser", "impact-bass-1"];
      try {
        results.push(resolveProjectMedia({ ...base, intent: intendedIntent }));
      } catch (error) {
        if (!(error instanceof MediaError)) throw error;
        let recovered = null;
        if (error.code === "media_unresolved" && effectiveMode === "local-only") {
          for (const cue of fallbackCues) {
            try {
              recovered = resolveProjectMedia({ ...base, intent: cue, force: true });
              recovered.fallbackCue = cue;
              recovered.requestedIntent = intendedIntent;
              recovered.status = "resolved-fallback";
              recordIndexEntry(projectDir, {
                localPath: recovered.path,
                resolvedVia: "local-fallback-cue",
                requestedIntent: intendedIntent,
                fallbackCue: cue,
              });
              break;
            } catch (fallbackError) {
              if (!(fallbackError instanceof MediaError)) throw fallbackError;
            }
          }
        }
        if (recovered) results.push(recovered);
        else {
          results.push({
            type: "sfx",
            status: error.exitCode === 5 ? "blocked" : "failed",
            code: error.code,
            reason: error.message,
            details: error.details ?? null,
            nextStep: "provide PROJECT_SPEC.mediaUse.sfx.from, .reuse, or a mediaUse.sfx.intent that a bundled cue can satisfy",
          });
        }
      }
    }
  }

  spec = loadSpec(projectDir);
  const report = {
    status: dryRun ? "planned" : "prepared",
    projectDir,
    mode: effectiveMode,
    generatedAt: new Date().toISOString(),
    results,
    bindings: {
      bgm: summarizeBinding(projectDir, "bgm", spec.audio?.bgmSource, spec.mediaUse?.bgm?.license),
      sfx: summarizeBinding(projectDir, "sfx", spec.opening?.flashSfx, spec.mediaUse?.sfx?.license),
    },
  };
  if (!dryRun) {
    writeJsonAtomic(reportPath(projectDir), report);
  }
  return report;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = prepareMedia({ ...options, root: options.project });
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.status}: ${result.projectDir}`);
      for (const item of result.results ?? []) console.log(`  ${item.type} ${item.status} ${item.path ?? ""}`);
      if (result.bgm || result.sfx) {
        for (const item of [result.bgm, result.sfx].filter(Boolean)) {
          console.log(`  ${item.type}: ${item.valid ? `${item.path} (${item.duration?.toFixed?.(3)}s, ${item.license})` : `invalid (${item.reason})`}`);
        }
      }
    }
    const failed = (result.results ?? []).some((item) => item.status === "blocked" || item.status === "failed");
    const verified = result.status === "verification_failed";
    process.exit(failed || verified ? 3 : 0);
  } catch (error) {
    const known = error instanceof MediaError;
    console.log(JSON.stringify({
      ok: false,
      status: known && [3, 5].includes(error.exitCode) ? "blocked" : "failed",
      code: known ? error.code : "unexpected_error",
      message: known ? error.message : String(error?.message ?? error),
      details: known ? error.details ?? null : null,
    }, null, 2));
    process.exit(known ? error.exitCode : 1);
  }
}

if (process.argv[1] && path.basename(process.argv[1]) === "prepare_media.mjs") {
  main();
}
