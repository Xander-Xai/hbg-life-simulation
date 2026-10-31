import fs from "node:fs";
import path from "node:path";
import {
  MediaError,
  SUPPORTED_TYPES,
  LICENSED_UNVERIFIED,
  assertInside,
  bindingFor,
  buildMediaUseArgs,
  canonicalTarget,
  classifyMediaFailure,
  copyIntoProject,
  defaultLicenseFor,
  fileIsNonEmpty,
  findIndexEntry,
  indexEntryIsUsable,
  normalizeAudioDuration,
  parseResolveOutput,
  projectMediaIndexPath,
  probeAudio,
  readJson,
  recordIndexEntry,
  resolveMediaCommand,
  runMediaUse,
  sha256File,
  sha256Text,
  toPosix,
  validateAudioAsset,
  validateBinding,
  writeJsonAtomic,
} from "./media_common.mjs";

const LOCAL_ONLY = "local-only";
const PRODUCTION = "production";

function parseArgs(argv) {
  const options = {
    project: process.cwd(),
    type: null,
    intent: null,
    mode: LOCAL_ONLY,
    from: null,
    reuse: null,
    dryRun: false,
    force: false,
    replaceBinding: false,
    normalizeDuration: null,
    license: null,
    publishAllowed: false,
    timeoutMs: 180000,
    json: false,
    use: null,
  };
  const valueFlags = new Set([
    "project", "type", "intent", "mode", "from", "reuse", "normalize-duration",
    "license", "timeout-ms", "use",
  ]);
  const boolFlags = new Set(["dry-run", "force", "replace-binding", "publish-allowed", "json"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new MediaError(`unexpected argument: ${token}`, { code: "usage", exitCode: 2 });
    const [rawName, inline] = token.slice(2).split("=", 2);
    if (boolFlags.has(rawName)) {
      if (inline !== undefined) throw new MediaError(`--${rawName} does not take a value`, { code: "usage", exitCode: 2 });
      if (rawName === "dry-run") options.dryRun = true;
      if (rawName === "force") options.force = true;
      if (rawName === "replace-binding") options.replaceBinding = true;
      if (rawName === "publish-allowed") options.publishAllowed = true;
      if (rawName === "json") options.json = true;
      continue;
    }
    if (!valueFlags.has(rawName)) throw new MediaError(`unknown option: --${rawName}`, { code: "usage", exitCode: 2 });
    const value = inline !== undefined ? inline : argv[++index];
    if (value === undefined) throw new MediaError(`--${rawName} requires a value`, { code: "usage", exitCode: 2 });
    if (rawName === "project") options.project = value;
    if (rawName === "type") options.type = value;
    if (rawName === "intent") options.intent = value;
    if (rawName === "mode") options.mode = value;
    if (rawName === "from") options.from = value;
    if (rawName === "reuse") options.reuse = value;
    if (rawName === "normalize-duration") options.normalizeDuration = Number(value);
    if (rawName === "license") options.license = value;
    if (rawName === "timeout-ms") options.timeoutMs = Number(value);
    if (rawName === "use") options.use = value;
  }
  return options;
}

function mediaUseManifestRelative(root) {
  const manifest = path.join(root, ".media", "manifest.jsonl");
  return fs.existsSync(manifest) ? toPosix(path.relative(root, manifest)) : null;
}

function specPath(root) {
  return path.join(root, "PROJECT_SPEC.json");
}

function specMediaSettings(spec, type) {
  const mediaUse = spec.mediaUse ?? {};
  const perType = mediaUse[type] ?? {};
  return { mediaUse, perType };
}

export function resolveProjectMedia({
  root,
  type,
  intent = null,
  mode = LOCAL_ONLY,
  from = null,
  reuse = null,
  dryRun = false,
  force = false,
  replaceBinding = false,
  normalizeDuration = null,
  license = null,
  publishAllowed = false,
  timeoutMs = 180000,
  command = null,
  cliUse = null,
}) {
  const projectDir = path.resolve(root);
  if (!SUPPORTED_TYPES.includes(type)) {
    throw new MediaError(`unsupported media type: ${type} (expected ${SUPPORTED_TYPES.join(" or ")})`, {
      code: "unsupported_type",
      exitCode: 2,
    });
  }
  if (![LOCAL_ONLY, PRODUCTION].includes(mode)) {
    throw new MediaError(`unsupported mode: ${mode} (expected ${LOCAL_ONLY} or ${PRODUCTION})`, {
      code: "unsupported_mode",
      exitCode: 2,
    });
  }
  const specFile = specPath(projectDir);
  if (!fs.existsSync(specFile)) throw new MediaError(`Missing PROJECT_SPEC.json: ${specFile}`, { code: "spec_missing", exitCode: 2 });
  const spec = readJson(specFile);
  const { mediaUse, perType } = specMediaSettings(spec, type);

  const resolvedIntent = intent ?? perType.intent ?? mediaUse.intent ?? null;
  if (!resolvedIntent && !from && !reuse) {
    throw new MediaError("--intent (or PROJECT_SPEC.mediaUse intent) is required unless --from/--reuse is used", {
      code: "usage",
      exitCode: 2,
    });
  }

  const existingBinding = bindingFor(spec, type);
  const existing = validateBinding(projectDir, type, existingBinding, { allowMissing: true });
  if (existing.valid && !replaceBinding && !force) {
    return {
      status: "reused-binding",
      type,
      id: null,
      path: existingBinding,
      absolutePath: existing.absolute,
      sha256: sha256File(existing.absolute),
      duration: existing.probe.duration,
      provider: "project-binding",
      license: perType.license ?? LICENSED_UNVERIFIED,
      publishAllowed: false,
      note: "existing valid project binding kept",
    };
  }

  const intentHash = resolvedIntent ? sha256Text(`${type}:${resolvedIntent}`) : null;
  const index = readJsonIfExists(projectMediaIndexPath(projectDir)) ?? { version: 1, entries: [] };
  const indexEntry = findIndexEntry(index, { type, intent: resolvedIntent, intentHash });
  if (indexEntry && indexEntryIsUsable(projectDir, indexEntry) && !force) {
    const absolute = path.resolve(projectDir, indexEntry.localPath);
    const nextSpec = structuredClone(spec);
    nextSpec.mediaUse ??= {};
    nextSpec.mediaUse[type] ??= {};
    nextSpec.mediaUse[type].resolvedAt = new Date().toISOString();
    nextSpec.mediaUse[type].lastProvider = indexEntry.provider ?? "project-cache";
    nextSpec.mediaUse[type].lastLicense = indexEntry.license ?? LICENSED_UNVERIFIED;
    if (type === "bgm") {
      nextSpec.audio ??= {};
      nextSpec.audio.bgmSource = indexEntry.localPath;
    } else {
      nextSpec.opening ??= {};
      nextSpec.opening.flashSfx = indexEntry.localPath;
    }
    writeJsonAtomic(specFile, nextSpec);
    return {
      status: "reused-cache",
      type,
      id: indexEntry.id ?? null,
      path: indexEntry.localPath,
      absolutePath: absolute,
      sha256: indexEntry.sha256,
      duration: indexEntry.duration ?? probeAudio(absolute).duration,
      provider: indexEntry.provider ?? "project-cache",
      license: indexEntry.license ?? LICENSED_UNVERIFIED,
      publishAllowed: Boolean(indexEntry.publishAllowed),
      bindingUpdated: true,
      note: "matched the project media index without a new media-use call",
    };
  }

  if (mode === PRODUCTION && mediaUse.allowExternalProviders !== true) {
    throw new MediaError(
      "production mode requires PROJECT_SPEC.mediaUse.allowExternalProviders=true; refusing to contact external providers",
      { code: "external_not_authorized", exitCode: 5 },
    );
  }

  const commandParts = command ?? resolveMediaCommand();
  const args = buildMediaUseArgs({
    type,
    intent: resolvedIntent,
    project: projectDir,
    to: from ? path.resolve(from) : null,
    reuse,
    localOnly: mode === LOCAL_ONLY,
    json: true,
  });
  if (cliUse) args.unshift("--use", cliUse);

  if (dryRun) {
    return {
      status: "planned",
      type,
      id: null,
      path: null,
      absolutePath: null,
      sha256: null,
      duration: null,
      provider: null,
      license: license ?? LICENSED_UNVERIFIED,
      publishAllowed: false,
      command: [...commandParts, ...args],
      note: "dry run: no media-use call was made",
    };
  }

  let outcome;
  try {
    outcome = runMediaUse({ command: commandParts, args, cwd: projectDir, timeoutMs });
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError("media-use invocation failed", { code: "media_failed", exitCode: 3, details: error.message });
  }
  if (outcome.status !== 0) {
    const classified = classifyMediaFailure(outcome);
    throw new MediaError(classified.message, {
      code: classified.code,
      exitCode: classified.exitCode,
      details: `${outcome.stdout}\n${outcome.stderr}`.trim(),
    });
  }
  const { data, format } = parseResolveOutput(outcome.stdout);
  if (data.ok === false) {
    const classified = classifyMediaFailure({ status: outcome.status, stdout: outcome.stdout, stderr: outcome.stderr });
    throw new MediaError(classified.message, {
      code: classified.code,
      exitCode: classified.exitCode,
      details: JSON.stringify(data),
    });
  }
  if (!data.path) {
    throw new MediaError("media-use result has no path", { code: "media_output_unparseable", exitCode: 3, details: outcome.stdout.trim() });
  }

  const reportedPath = path.isAbsolute(data.path) ? data.path : path.resolve(projectDir, data.path);
  const reported = assertInside(projectDir, reportedPath, "media-use asset");
  if (!fileIsNonEmpty(reported)) {
    throw new MediaError(`media-use reported a missing file: ${data.path}`, { code: "media_file_missing", exitCode: 4 });
  }
  const probe = validateAudioAsset(reported, { label: `${type} asset` });
  const reportedSha = sha256File(reported);

  const extension = path.extname(reported) || ".mp3";
  const targetRelative = canonicalTarget(type, data.id ?? `${type}_${reportedSha.slice(0, 8)}`, extension);
  let copied;
  try {
    copied = copyIntoProject({ root: projectDir, source: reported, relativeTarget: targetRelative });
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(`unable to copy media into the project: ${error.message}`, { code: "copy_failed", exitCode: 4 });
  }
  let boundRelative = toPosix(path.relative(projectDir, copied.target));
  let boundAbsolute = copied.target;
  let boundSha = copied.sha256;
  let boundProbe = copied.copied ? probeAudio(copied.target) : probe;
  let preparedFrom = null;

  if (normalizeDuration !== null && normalizeDuration !== undefined) {
    if (!Number.isFinite(normalizeDuration) || normalizeDuration <= 0) {
      throw new MediaError(`--normalize-duration must be a positive number: ${normalizeDuration}`, { code: "usage", exitCode: 2 });
    }
    const normalizedRelative = `assets/audio/${type}/${path.basename(boundRelative, path.extname(boundRelative))}-${normalizeDuration}s.m4a`;
    const normalizedAbsolute = assertInside(projectDir, normalizedRelative, "normalized media");
    const normalized = normalizeAudioDuration({ source: boundAbsolute, target: normalizedAbsolute, seconds: normalizeDuration });
    preparedFrom = boundRelative;
    boundRelative = normalizedRelative;
    boundAbsolute = normalized.target;
    boundSha = normalized.sha256;
    boundProbe = probeAudio(normalized.target);
  }

  const provenance = data.provenance ?? {};
  const licenseDefault = defaultLicenseFor(provenance);
  const finalLicense = license ?? perType.license ?? licenseDefault.license;
  const finalPublishAllowed = Boolean(publishAllowed) && finalLicense !== LICENSED_UNVERIFIED;

  const entry = {
    id: data.id ?? null,
    type,
    intent: resolvedIntent,
    intentHash,
    localPath: boundRelative,
    originalPath: toPosix(path.relative(projectDir, copied.target)),
    preparedFrom,
    sha256: boundSha,
    bytes: fs.statSync(boundAbsolute).size,
    duration: boundProbe.duration,
    codec: boundProbe.codec,
    sampleRate: boundProbe.sampleRate,
    channels: boundProbe.channels,
    provider: provenance.provider ?? data.source ?? "media-use",
    source: data.source ?? null,
    mediaUseId: data.id ?? null,
    mediaUseManifest: mediaUseManifestRelative(projectDir),
    outputFormat: format,
    license: finalLicense,
    licenseNote: licenseDefault.note,
    publishAllowed: finalPublishAllowed,
    usage: bindingFor(spec, type) === null ? "new-binding" : "replaced-binding",
    verified: true,
  };
  recordIndexEntry(projectDir, entry);

  spec.mediaUse ??= {};
  spec.mediaUse[type] ??= {};
  spec.mediaUse[type].resolvedAt = new Date().toISOString();
  spec.mediaUse[type].lastProvider = entry.provider;
  spec.mediaUse[type].lastLicense = finalLicense;
  const nextSpec = structuredClone(spec);
  // setBinding mutates the spec copy; then persist once.
  if (type === "bgm") {
    nextSpec.audio ??= {};
    nextSpec.audio.bgmSource = boundRelative;
  } else {
    nextSpec.opening ??= {};
    nextSpec.opening.flashSfx = boundRelative;
  }
  writeJsonAtomic(specFile, nextSpec);

  return {
    status: preparedFrom ? "resolved-normalized" : "resolved",
    type,
    id: entry.id,
    path: boundRelative,
    absolutePath: boundAbsolute,
    sha256: boundSha,
    duration: entry.duration,
    provider: entry.provider,
    source: entry.source,
    license: entry.license,
    publishAllowed: entry.publishAllowed,
    preparedFrom,
    copied: copied.copied,
    bindingUpdated: true,
  };
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return readJson(file);
}

function print(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.status === "planned") {
    console.log(`plan: ${result.command.join(" ")}`);
    return;
  }
  console.log(`${result.status}: ${result.type} ${result.id ?? "-"} -> ${result.path ?? "-"}`);
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (!options.type) throw new MediaError("--type is required (bgm or sfx)", { code: "usage", exitCode: 2 });
    const root = path.resolve(options.project);
    if (!fs.existsSync(path.join(root, "PROJECT_SPEC.json"))) {
      throw new MediaError(`PROJECT_SPEC.json not found in ${root}`, { code: "spec_missing", exitCode: 2 });
    }
    const result = resolveProjectMedia({ ...options, root });
    print(result, options.json);
    const code = result.status === "planned" ? 0 : 0;
    process.exit(code);
  } catch (error) {
    const known = error instanceof MediaError;
    const payload = {
      ok: false,
      status: known && [3, 5].includes(error.exitCode) ? "blocked" : "failed",
      code: known ? error.code : "unexpected_error",
      message: known ? error.message : String(error?.message ?? error),
      details: known ? error.details ?? null : null,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(known ? error.exitCode : 1);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("resolve_media.mjs")) {
  main();
}
