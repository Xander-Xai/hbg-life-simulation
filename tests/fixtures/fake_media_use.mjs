#!/usr/bin/env node
// Deterministic stand-in for `hyperframes media-use resolve` used by the test
// suite. Behaviour is driven by FAKE_MEDIA_MODE so tests can exercise success,
// provider failure, invalid JSON, missing files, path escapes and timeouts
// without network access or an account.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
};

const mode = process.env.FAKE_MEDIA_MODE ?? "ok";
const type = valueOf("--type") ?? "bgm";
const project = path.resolve(valueOf("--project") ?? ".");
const intent = valueOf("--intent") ?? "unspecified";
const failIntent = process.env.FAKE_MEDIA_FAIL_INTENT ?? null;

function emit(payload, code = 0) {
  console.log(JSON.stringify(payload));
  process.exit(code);
}

if (failIntent && intent.includes(failIntent)) {
  console.error(`error: no provider could resolve ${type}: "${intent}"`);
  emit({ ok: false, error: `no provider could resolve ${type}: "${intent}"` }, 1);
} else if (mode === "timeout") {
  setTimeout(() => emit({ ok: true }), 30000);
} else if (mode === "unresolved") {
  console.error(`error: no provider could resolve ${type}: "${intent}"`);
  emit({ ok: false, error: `no provider could resolve ${type}: "${intent}"` }, 1);
} else if (mode === "auth") {
  console.error("error: provider requires auth; run login");
  emit({ ok: false, error: "auth required" }, 1);
} else if (mode === "invalid-json") {
  console.log("resolved?? this is not json");
  process.exit(0);
} else if (mode === "escape") {
  emit({
    ok: true,
    id: `${type}_evil`,
    type,
    path: "../../outside.mp3",
    source: "fake",
    provenance: { provider: "fake.local", prompt: intent },
  });
} else if (mode === "missing-file") {
  emit({
    ok: true,
    id: `${type}_gone`,
    type,
    path: `.media/audio/${type}/does-not-exist.mp3`,
    source: "fake",
    provenance: { provider: "fake.local", prompt: intent },
  });
} else {
  const source = process.env.FAKE_MEDIA_SOURCE;
  if (!source || !fs.existsSync(source)) {
    console.error("fake media source is missing");
    process.exit(9);
  }
  const relative = `.media/audio/${type}/${type}_001${path.extname(source)}`;
  const target = path.join(project, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  const manifest = path.join(project, ".media", "manifest.jsonl");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.appendFileSync(
    manifest,
    `${JSON.stringify({ id: `${type}_001`, type, path: relative, source: "fake", description: intent, provenance: { provider: "fake.local", prompt: intent } })}\n`,
  );
  emit({
    ok: true,
    id: `${type}_001`,
    type,
    path: relative,
    source: "fake",
    description: intent,
    duration: null,
    provenance: { provider: "fake.local", prompt: intent },
  });
}
