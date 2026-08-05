# Local account API with CLIProxyAPI

Use this as the preferred HBG image channel only after a per-project explicit consent gate. The Skill must check readiness first, ask before consuming account capacity and before installation, startup, repair, login, or OAuth, and use built-in ImageGen when the user declines or the account lacks image entitlement.

CLIProxyAPI is a third-party MIT-licensed project: <https://github.com/router-for-me/CLIProxyAPI>. It supports Codex, Claude, Antigravity, Kimi, and xAI OAuth, plus OpenAI-compatible Responses and Images endpoints. It is not an official provider client and does not bypass quotas, entitlements, rate limits, or provider terms.

## Security contract

- Treat Skill invocation and a request to make a video as insufficient consent to use account capacity, set up the proxy, or start OAuth.
- Require a fresh confirmation before using the local account channel for each new video project, even when the proxy is already ready.
- Require explicit OAuth-risk acceptance before login.
- Ask before starting a configured but stopped proxy.
- Use only accounts owned or administered by the user.
- Bind to `127.0.0.1`; never expose the proxy on `0.0.0.0`, a LAN address, a tunnel, or a public server.
- Disable remote management and the management panel.
- Store the binary, config, local client key, OAuth records, PID, and logs outside every project and Git worktree.
- Use permissions `0700` for credential directories and `0600` for config and environment files.
- Never print, paste, summarize, upload, or commit provider OAuth records or the generated local client key.
- Never inspect browser cookies, browser storage, account pages, `auths/`, `client.env`, or provider OAuth files. The user completes browser/device authentication personally.
- Do not patch the running Codex application's own transport configuration. Use the local endpoint only from explicit compatible clients and batch scripts.

## Bootstrap

First run the read-only readiness check:

```bash
scripts/setup_local_cliproxyapi.sh ready
```

It returns exactly one non-secret state: `ready`, `not-configured`, `not-running`, or `unhealthy`. Do not install, start, repair, or log in until the user has agreed after seeing the third-party, account-capacity, and OAuth disclosure.

After consent, from the installed skill directory:

```bash
scripts/setup_local_cliproxyapi.sh bootstrap \
  --provider codex \
  --accept-oauth-risk
```

For a terminal without a browser callback, use the Codex device flow:

```bash
scripts/setup_local_cliproxyapi.sh bootstrap \
  --provider codex-device \
  --accept-oauth-risk \
  --no-browser
```

The script downloads a pinned upstream release, verifies its published SHA-256 checksum, creates a localhost-only configuration, runs OAuth, starts the service, and checks the authenticated `/v1/models` endpoint.

OAuth is an interactive user action. The Agent may launch the flow or display the device code only after consent, but must not operate the provider login page, read the account, retrieve cookies, or inspect the resulting OAuth files.

Default local state:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/hbg-life-simulation/cliproxyapi/
├── bin/cli-proxy-api
├── config.yaml
├── client.env
├── auths/
├── logs/
├── VERSION
└── UPSTREAM
```

`client.env` exports `OPENAI_BASE_URL`, a generated localhost-only `OPENAI_API_KEY`, and `HBG_IMAGE_MODEL`. Source it only in the process that needs the API:

```bash
source "$(scripts/setup_local_cliproxyapi.sh env-path)"
```

## Lifecycle

```bash
scripts/setup_local_cliproxyapi.sh status
scripts/setup_local_cliproxyapi.sh ready
scripts/setup_local_cliproxyapi.sh smoke-test
scripts/setup_local_cliproxyapi.sh stop
scripts/setup_local_cliproxyapi.sh start
scripts/setup_local_cliproxyapi.sh login --provider codex --accept-oauth-risk
```

Do not delete or replace an unknown process. The stop command acts only on the PID whose command line matches this integration's binary and config paths.

## HBG image batches

CLIProxyAPI currently provides `/v1/images/generations` and `/v1/images/edits` for supported image models, including `gpt-image-2`. Confirm the local models endpoint and one deliberate single-image test before starting a large batch. A successful models request does not prove that the user's account has image entitlement.

```bash
source "$(scripts/setup_local_cliproxyapi.sh env-path)"

IMAGE_GEN="${CODEX_HOME:-$HOME/.codex}/skills/.system/imagegen/scripts/image_gen.py"
python "$IMAGE_GEN" generate \
  --model "${HBG_IMAGE_MODEL:-gpt-image-2}" \
  --prompt "A simple comic-style empty room, no text" \
  --size 1536x1024 \
  --out /tmp/hbg-local-api-smoke.png \
  --no-augment
```

The image test consumes account capacity and must be intentional. Display and inspect the returned image in chat before approving this channel for project batches.

After it passes, use the existing `generate-batch` path with concurrency 5. Do not raise concurrency above 10 or use the proxy to evade account limits. Keep the same `SHEET_MAP.json`, staging, dimension normalization, anatomy review, and accounting requirements as any other compatible API.

## Failure handling

- `401` from the local endpoint: load the correct `client.env`; do not replace it with the provider OAuth token.
- No models or upstream authorization failure: rerun the selected provider login and inspect only non-secret status output.
- Image endpoint unsupported or entitlement missing: fall back to built-in ImageGen or another user-authorized Images API.
- OAuth callback port conflict: use `codex-device` or stop the process occupying the provider callback port; do not weaken the loopback binding.
- Release download or checksum failure: stop. Never install an unverified archive.
- Port 8317 conflict: choose another local port during first install; keep `OPENAI_BASE_URL` and the config synchronized through the setup script.
