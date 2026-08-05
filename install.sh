#!/usr/bin/env bash
set -euo pipefail

repo_url="https://github.com/Mr-funny/hbg-life-simulation.git"
skill_name="hbg-life-simulation"
legacy_skill_name="life-simulation"
install_kind="codex"
custom_target=""
with_local_proxy=false
proxy_provider="codex"
proxy_no_browser=false
accept_oauth_risk=false
proxy_root=""
proxy_port=""

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --claude                    Install into the Claude Code skills directory.
  --target <skills-directory> Install into a custom skills directory.
  --with-local-proxy          Also bootstrap localhost-only CLIProxyAPI.
  --proxy-provider <name>     codex, codex-device, claude, antigravity, kimi, or xai.
  --proxy-root <directory>    Override the project-external local proxy state directory.
  --proxy-port <number>       Override the localhost API port.
  --proxy-no-browser          Do not open a browser automatically during OAuth.
  --accept-oauth-risk         Accept the third-party OAuth proxy risk disclosure.
  -h, --help                  Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --claude)
      install_kind="claude"
      shift
      ;;
    --target)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      custom_target=$2
      shift 2
      ;;
    --with-local-proxy)
      with_local_proxy=true
      shift
      ;;
    --proxy-provider)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      proxy_provider=$2
      shift 2
      ;;
    --proxy-root)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      proxy_root=$2
      shift 2
      ;;
    --proxy-port)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      proxy_port=$2
      shift 2
      ;;
    --proxy-no-browser)
      proxy_no_browser=true
      shift
      ;;
    --accept-oauth-risk)
      accept_oauth_risk=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$proxy_provider" in
  codex|codex-device|claude|antigravity|kimi|xai) ;;
  *) echo "Unsupported proxy provider: $proxy_provider" >&2; exit 2 ;;
esac

if [[ -n "$proxy_port" ]]; then
  [[ "$proxy_port" =~ ^[0-9]+$ ]] || { echo "Proxy port must be numeric" >&2; exit 2; }
  (( proxy_port >= 1024 && proxy_port <= 65535 )) || { echo "Proxy port must be between 1024 and 65535" >&2; exit 2; }
fi

if $with_local_proxy && ! $accept_oauth_risk; then
  cat >&2 <<'EOF'
--with-local-proxy uses the third-party CLIProxyAPI OAuth flow. It is not an
official provider client, may break, and remains subject to provider terms and
account quotas. Re-run with --accept-oauth-risk only for an account you own.
EOF
  exit 2
fi

for required in git mktemp node; do
  command -v "$required" >/dev/null 2>&1 || {
    echo "Missing required command: $required" >&2
    exit 2
  }
done

if [[ -n "$custom_target" ]]; then
  skills_root=$custom_target
elif [[ "$install_kind" == "claude" ]]; then
  skills_root="$HOME/.claude/skills"
elif [[ -n "${CODEX_HOME:-}" ]]; then
  skills_root="$CODEX_HOME/skills"
else
  skills_root="$HOME/.codex/skills"
fi

target_dir="$skills_root/$skill_name"
legacy_dir="$skills_root/$legacy_skill_name"
temp_dir=$(mktemp -d)
cleanup() {
  [[ -d "$temp_dir" ]] && rm -r "$temp_dir"
}
trap cleanup EXIT

git clone --depth 1 "$repo_url" "$temp_dir/repo" >/dev/null

mkdir -p "$skills_root"
if [[ ! -e "$target_dir" && -e "$legacy_dir" ]]; then
  legacy_backup="${legacy_dir}.backup.$(date +%Y%m%d-%H%M%S)"
  mv "$legacy_dir" "$legacy_backup"
  echo "Backed up legacy skill to $legacy_backup"
fi
if [[ -e "$target_dir" ]]; then
  backup_dir="${target_dir}.backup.$(date +%Y%m%d-%H%M%S)"
  mv "$target_dir" "$backup_dir"
  echo "Backed up existing skill to $backup_dir"
fi

mkdir -p "$target_dir"
cp "$temp_dir/repo/SKILL.md" "$target_dir/SKILL.md"
cp -R "$temp_dir/repo/agents" "$target_dir/agents"
cp -R "$temp_dir/repo/assets" "$target_dir/assets"
cp -R "$temp_dir/repo/references" "$target_dir/references"
cp -R "$temp_dir/repo/scripts" "$target_dir/scripts"
chmod +x "$target_dir/scripts/"*.sh

test -f "$target_dir/SKILL.md"
for script in "$target_dir/scripts/"*.sh; do
  bash -n "$script"
done
for script in "$target_dir/scripts/"*.mjs; do
  node --check "$script"
done

echo "Installed $skill_name to $target_dir"
echo "Invoke it as \$$skill_name"

if $with_local_proxy; then
  proxy_args=(bootstrap --provider "$proxy_provider" --accept-oauth-risk)
  if [[ -n "$proxy_root" ]]; then
    proxy_args+=(--root "$proxy_root")
  fi
  if [[ -n "$proxy_port" ]]; then
    proxy_args+=(--port "$proxy_port")
  fi
  if $proxy_no_browser; then
    proxy_args+=(--no-browser)
  fi
  "$target_dir/scripts/setup_local_cliproxyapi.sh" "${proxy_args[@]}"
fi
