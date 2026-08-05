#!/usr/bin/env bash
set -euo pipefail

upstream_repo="router-for-me/CLIProxyAPI"
upstream_url="https://github.com/router-for-me/CLIProxyAPI"
default_release="v7.2.119"
default_port="8317"

command_name="bootstrap"
if [[ $# -gt 0 && "$1" != -* ]]; then
  command_name=$1
  shift
fi

provider="codex"
release_tag="${HBG_CLIPROXY_RELEASE:-$default_release}"
port="${HBG_CLIPROXY_PORT:-$default_port}"
port_explicit=false
data_root="${XDG_DATA_HOME:-$HOME/.local/share}"
root_dir="${HBG_CLIPROXY_HOME:-$data_root/hbg-life-simulation/cliproxyapi}"
accept_oauth_risk=false
no_browser=false
force_config=false
force_install=false
dry_run=false

usage() {
  cat <<'EOF'
Usage:
  setup_local_cliproxyapi.sh [ready|bootstrap|install|login|start|stop|status|smoke-test|env-path] [options]

Commands:
  ready       Check whether the managed local API is configured, running, and healthy.
  bootstrap   Install, create a localhost-only config, log in, start, and test.
  install     Install the verified CLIProxyAPI release and create local config only.
  login       Run the selected provider OAuth flow.
  start       Start the localhost proxy in the background.
  stop        Stop the process recorded by this integration.
  status      Show process and local API status without printing credentials.
  smoke-test  Call the authenticated local /v1/models endpoint.
  env-path    Print the path of the local client environment file.

Options:
  --provider <codex|codex-device|claude|antigravity|kimi|xai>
  --root <directory>       Store binary, OAuth files, config, and logs outside projects.
  --port <number>          Local loopback port. Default: 8317.
  --release <tag>          Pinned upstream release. Default: v7.2.119.
  --accept-oauth-risk      Confirm use of a third-party OAuth proxy.
  --no-browser             Do not open a browser automatically for OAuth.
  --force-config           Back up and replace this integration's local config.
  --force-install          Re-download the selected release.
  --dry-run                Print the plan without downloading, logging in, or writing files.
  -h, --help               Show this help.

This script never modifies Codex configuration, never prints OAuth tokens, and binds only
to 127.0.0.1. It does not bypass provider quotas, entitlements, or terms of service.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --provider)
      [[ $# -ge 2 ]] || die "--provider requires a value"
      provider=$2
      shift 2
      ;;
    --root)
      [[ $# -ge 2 ]] || die "--root requires a directory"
      root_dir=$2
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port requires a number"
      port=$2
      port_explicit=true
      shift 2
      ;;
    --release)
      [[ $# -ge 2 ]] || die "--release requires a tag"
      release_tag=$2
      shift 2
      ;;
    --accept-oauth-risk)
      accept_oauth_risk=true
      shift
      ;;
    --no-browser)
      no_browser=true
      shift
      ;;
    --force-config)
      force_config=true
      shift
      ;;
    --force-install)
      force_install=true
      shift
      ;;
    --dry-run)
      dry_run=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$command_name" in
  ready|bootstrap|install|login|start|stop|status|smoke-test|env-path) ;;
  *) die "unknown command: $command_name" ;;
esac

case "$provider" in
  codex|codex-device|claude|antigravity|kimi|xai) ;;
  *) die "unsupported provider: $provider" ;;
esac

[[ "$port" =~ ^[0-9]+$ ]] || die "port must be numeric"
(( port >= 1024 && port <= 65535 )) || die "port must be between 1024 and 65535"
[[ "$release_tag" == v* ]] || release_tag="v$release_tag"

if [[ "$root_dir" != /* ]]; then
  root_dir="$PWD/$root_dir"
fi
case "$root_dir" in
  *$'\n'*|*\"*|*\'*) die "root directory cannot contain a newline or quote" ;;
esac

if git_root=$(git rev-parse --show-toplevel 2>/dev/null); then
  case "$root_dir/" in
    "$git_root/"*) die "refusing to store OAuth data inside the current Git worktree: $git_root" ;;
  esac
fi

bin_dir="$root_dir/bin"
binary_path="$bin_dir/cli-proxy-api"
config_path="$root_dir/config.yaml"
auth_dir="$root_dir/auths"
logs_dir="$root_dir/logs"
env_path="$root_dir/client.env"
pid_path="$root_dir/cli-proxy-api.pid"
log_path="$logs_dir/server.log"
risk_path="$root_dir/OAUTH_RISK_ACCEPTED"
version_path="$root_dir/VERSION"

if [[ -f "$config_path" && "$port_explicit" != true ]]; then
  configured_port=$(sed -n 's/^port:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$config_path" | sed -n '1p')
  if [[ -n "$configured_port" ]]; then
    (( configured_port >= 1024 && configured_port <= 65535 )) || die "configured port is outside 1024-65535"
    port=$configured_port
  fi
fi

print_plan() {
  cat <<EOF
CLIProxyAPI integration plan
  command:  $command_name
  provider: $provider
  release:  $release_tag
  root:     $root_dir
  endpoint: http://127.0.0.1:$port/v1
  bind:     localhost only
EOF
}

if $dry_run; then
  print_plan
  exit 0
fi

umask 077

ensure_commands() {
  for required_cmd in curl git mktemp tar awk; do
    command -v "$required_cmd" >/dev/null 2>&1 || die "missing required command: $required_cmd"
  done
  if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
    die "shasum or sha256sum is required"
  fi
}

platform_asset() {
  local system_name machine_name platform_name arch_name version_number
  system_name=$(uname -s)
  machine_name=$(uname -m)
  case "$system_name" in
    Darwin) platform_name="darwin" ;;
    Linux) platform_name="linux" ;;
    *) die "unsupported operating system: $system_name; use EasyCLIProxyAPI on Windows" ;;
  esac
  case "$machine_name" in
    arm64|aarch64) arch_name="aarch64" ;;
    x86_64|amd64) arch_name="amd64" ;;
    *) die "unsupported architecture: $machine_name" ;;
  esac
  version_number=${release_tag#v}
  printf 'CLIProxyAPI_%s_%s_%s.tar.gz\n' "$version_number" "$platform_name" "$arch_name"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

download_release_file() {
  local destination_dir asset_name=$1
  destination_dir=$2
  if command -v gh >/dev/null 2>&1; then
    if gh release download "$release_tag" --repo "$upstream_repo" \
      --pattern "$asset_name" --dir "$destination_dir" --clobber; then
      return
    fi
    rm -f "$destination_dir/$asset_name"
  fi
  curl --fail --location --silent --show-error --retry 3 \
    --connect-timeout 20 --max-time 900 \
    "$upstream_url/releases/download/$release_tag/$asset_name" \
    --output "$destination_dir/$asset_name"
}

install_release() {
  ensure_commands
  if [[ -x "$binary_path" && -f "$version_path" ]] && ! $force_install; then
    installed_release=$(tr -d '[:space:]' < "$version_path")
    if [[ "$installed_release" == "$release_tag" ]]; then
      echo "CLIProxyAPI $release_tag is already installed."
      return
    fi
  fi

  mkdir -p "$bin_dir" "$auth_dir" "$logs_dir"
  chmod 700 "$root_dir" "$bin_dir" "$auth_dir" "$logs_dir"

  local asset_name temp_dir checksum_expected checksum_actual extracted_binary
  asset_name=$(platform_asset)
  temp_dir=$(mktemp -d)
  trap 'rm -rf "$temp_dir"' EXIT

  echo "Downloading $upstream_repo $release_tag..."
  download_release_file checksums.txt "$temp_dir"
  download_release_file "$asset_name" "$temp_dir"

  checksum_expected=$(awk -v wanted="$asset_name" '$2 == wanted {print $1; exit}' "$temp_dir/checksums.txt")
  [[ -n "$checksum_expected" ]] || die "release checksum is missing for $asset_name"
  checksum_actual=$(sha256_file "$temp_dir/$asset_name")
  [[ "$checksum_actual" == "$checksum_expected" ]] || die "release checksum mismatch for $asset_name"

  while IFS= read -r archive_entry; do
    case "$archive_entry" in
      /*|*../*) die "unsafe path in upstream archive: $archive_entry" ;;
    esac
  done < <(tar -tzf "$temp_dir/$asset_name")

  mkdir -p "$temp_dir/extracted"
  tar -xzf "$temp_dir/$asset_name" -C "$temp_dir/extracted"
  extracted_binary="$temp_dir/extracted/cli-proxy-api"
  [[ -f "$extracted_binary" ]] || die "upstream archive does not contain cli-proxy-api"

  if [[ -e "$binary_path" ]]; then
    mv "$binary_path" "$binary_path.backup.$(date +%Y%m%d-%H%M%S)"
  fi
  cp "$extracted_binary" "$binary_path"
  chmod 700 "$binary_path"
  printf '%s\n' "$release_tag" > "$version_path"
  printf 'upstream=%s\nrelease=%s\nasset=%s\nsha256=%s\n' \
    "$upstream_url" "$release_tag" "$asset_name" "$checksum_actual" > "$root_dir/UPSTREAM"
  chmod 600 "$version_path" "$root_dir/UPSTREAM"
  rm -rf "$temp_dir"
  trap - EXIT
  echo "Installed CLIProxyAPI $release_tag to $binary_path"
}

generate_local_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  elif command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
  else
    od -An -N24 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

extract_local_key() {
  sed -n '/^api-keys:/,/^[^[:space:]]/s/^[[:space:]]*-[[:space:]]*"\([^"]*\)".*/\1/p' "$config_path" | sed -n '1p'
}

write_client_env() {
  local local_key=$1
  cat > "$env_path" <<EOF
export OPENAI_BASE_URL='http://127.0.0.1:$port/v1'
export OPENAI_API_KEY='$local_key'
export HBG_IMAGE_MODEL='gpt-image-2'
export HBG_CLIPROXY_CONFIG='$config_path'
export HBG_CLIPROXY_BINARY='$binary_path'
EOF
  chmod 600 "$env_path"
}

write_config() {
  mkdir -p "$root_dir" "$auth_dir" "$logs_dir"
  chmod 700 "$root_dir" "$auth_dir" "$logs_dir"

  if [[ -f "$config_path" && "$force_config" != true ]]; then
    local existing_key existing_port
    existing_key=$(extract_local_key)
    existing_port=$(sed -n 's/^port:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$config_path" | sed -n '1p')
    [[ -n "$existing_key" ]] || die "existing config is not managed by this integration; use a different --root"
    if $port_explicit && [[ -n "$existing_port" && "$existing_port" != "$port" ]]; then
      die "existing config uses port $existing_port; use --force-config to replace it"
    fi
    [[ -f "$env_path" ]] || write_client_env "$existing_key"
    echo "Keeping existing local config: $config_path"
    return
  fi

  if [[ -f "$config_path" ]]; then
    mv "$config_path" "$config_path.backup.$(date +%Y%m%d-%H%M%S)"
  fi
  if [[ -f "$env_path" ]]; then
    mv "$env_path" "$env_path.backup.$(date +%Y%m%d-%H%M%S)"
  fi

  local local_key
  local_key="hbg-local-$(generate_local_key)"
  cat > "$config_path" <<EOF
host: "127.0.0.1"
port: $port

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: true

auth-dir: "$auth_dir"

api-keys:
  - "$local_key"

debug: false
pprof:
  enable: false
  addr: "127.0.0.1:8316"
logging-to-file: false
usage-statistics-enabled: false
disable-image-generation: false
routing:
  strategy: "round-robin"
EOF
  chmod 600 "$config_path"
  write_client_env "$local_key"
  echo "Created localhost-only config: $config_path"
  echo "Created protected client environment: $env_path"
}

require_oauth_consent() {
  if [[ -f "$risk_path" ]]; then
    return
  fi
  if ! $accept_oauth_risk; then
    cat >&2 <<EOF
CLIProxyAPI is a third-party OAuth proxy, not an official provider API client.
It may break when providers change their systems and use may be subject to provider terms.
Use only accounts you own and are authorized to use. This integration does not bypass quotas.

Re-run with --accept-oauth-risk to continue the OAuth login.
EOF
    exit 2
  fi
  mkdir -p "$root_dir"
  printf 'accepted_at=%s\nupstream=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$upstream_url" > "$risk_path"
  chmod 600 "$risk_path"
}

login_provider() {
  [[ -x "$binary_path" ]] || die "CLIProxyAPI is not installed; run install first"
  [[ -f "$config_path" ]] || die "local config is missing; run install first"
  require_oauth_consent

  local login_flag
  case "$provider" in
    codex) login_flag="-codex-login" ;;
    codex-device) login_flag="-codex-device-login" ;;
    claude) login_flag="-claude-login" ;;
    antigravity) login_flag="-antigravity-login" ;;
    kimi) login_flag="-kimi-login" ;;
    xai) login_flag="-xai-login" ;;
  esac
  echo "Starting $provider OAuth login. Provider tokens remain under $auth_dir."
  if $no_browser || [[ "$provider" == "codex-device" ]]; then
    "$binary_path" -config "$config_path" "$login_flag" -no-browser
  else
    "$binary_path" -config "$config_path" "$login_flag"
  fi
}

pid_is_ours() {
  [[ -f "$pid_path" ]] || return 1
  local saved_pid process_command
  saved_pid=$(tr -d '[:space:]' < "$pid_path")
  [[ "$saved_pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$saved_pid" 2>/dev/null || return 1
  process_command=$(ps -p "$saved_pid" -o command= 2>/dev/null || true)
  [[ "$process_command" == *"$binary_path"* && "$process_command" == *"$config_path"* ]]
}

start_proxy() {
  [[ -x "$binary_path" ]] || die "CLIProxyAPI is not installed; run install first"
  [[ -f "$config_path" ]] || die "local config is missing; run install first"
  if pid_is_ours; then
    echo "CLIProxyAPI is already running with PID $(tr -d '[:space:]' < "$pid_path")."
    return
  fi
  rm -f "$pid_path"
  mkdir -p "$logs_dir"
  chmod 700 "$logs_dir"
  : > "$log_path"
  chmod 600 "$log_path"
  nohup "$binary_path" -config "$config_path" > "$log_path" 2>&1 &
  proxy_pid=$!
  printf '%s\n' "$proxy_pid" > "$pid_path"
  chmod 600 "$pid_path"

  for _ in {1..40}; do
    if kill -0 "$proxy_pid" 2>/dev/null && curl --silent --output /dev/null "http://127.0.0.1:$port/"; then
      echo "CLIProxyAPI started on http://127.0.0.1:$port"
      return
    fi
    sleep 0.25
  done
  die "CLIProxyAPI did not become ready; inspect the protected local log at $log_path"
}

stop_proxy() {
  if ! pid_is_ours; then
    echo "No integration-managed CLIProxyAPI process is running."
    rm -f "$pid_path"
    return
  fi
  local saved_pid
  saved_pid=$(tr -d '[:space:]' < "$pid_path")
  kill "$saved_pid"
  for _ in {1..20}; do
    if ! kill -0 "$saved_pid" 2>/dev/null; then
      rm -f "$pid_path"
      echo "Stopped CLIProxyAPI PID $saved_pid."
      return
    fi
    sleep 0.25
  done
  die "process $saved_pid did not stop after SIGTERM; inspect it manually"
}

load_client_env() {
  [[ -f "$env_path" ]] || die "client environment is missing: $env_path"
  # shellcheck disable=SC1090
  source "$env_path"
  export OPENAI_BASE_URL OPENAI_API_KEY
}

smoke_test() {
  load_client_env
  local response_file http_code
  response_file=$(mktemp)
  if ! http_code=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --header "Authorization: Bearer $OPENAI_API_KEY" \
      "$OPENAI_BASE_URL/models"); then
    rm -f "$response_file"
    die "cannot connect to the local API at $OPENAI_BASE_URL"
  fi
  if [[ "$http_code" != "200" ]]; then
    rm -f "$response_file"
    die "local API smoke test returned HTTP $http_code"
  fi
  rm -f "$response_file"
  echo "Local authenticated API smoke test: OK ($OPENAI_BASE_URL/models)"
}

ready_check() {
  if [[ ! -x "$binary_path" || ! -f "$config_path" || ! -f "$env_path" ]]; then
    echo "not-configured"
    exit 3
  fi
  if ! pid_is_ours; then
    echo "not-running"
    exit 4
  fi

  load_client_env
  local response_file http_code
  response_file=$(mktemp)
  if ! http_code=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --header "Authorization: Bearer $OPENAI_API_KEY" \
      "$OPENAI_BASE_URL/models"); then
    rm -f "$response_file"
    echo "unhealthy"
    exit 5
  fi
  rm -f "$response_file"
  if [[ "$http_code" != "200" ]]; then
    echo "unhealthy"
    exit 5
  fi
  echo "ready"
}

show_status() {
  if pid_is_ours; then
    echo "process: running (PID $(tr -d '[:space:]' < "$pid_path"))"
  else
    echo "process: not running"
  fi
  echo "endpoint: http://127.0.0.1:$port/v1"
  echo "client environment: $env_path"
  echo "OAuth directory: $auth_dir"
}

case "$command_name" in
  ready)
    ready_check
    ;;
  bootstrap)
    print_plan
    install_release
    write_config
    login_provider
    start_proxy
    smoke_test
    ;;
  install)
    print_plan
    install_release
    write_config
    ;;
  login)
    login_provider
    ;;
  start)
    start_proxy
    ;;
  stop)
    stop_proxy
    ;;
  status)
    show_status
    ;;
  smoke-test)
    smoke_test
    ;;
  env-path)
    printf '%s\n' "$env_path"
    ;;
esac

if [[ "$command_name" == "bootstrap" || "$command_name" == "install" ]]; then
  cat <<EOF

Load this local API only in the shell that needs it:
  source "$env_path"

The generated OPENAI_API_KEY authenticates only your localhost proxy. It is not the
provider OAuth token. Never copy config.yaml, client.env, auths, or logs into a project.
EOF
fi
