#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${PLUGIN_DIR:-/opt/openclaw/plugins/biwenger-focus}"
MCP_DIR="${MCP_DIR:-/opt/biwenger-mcp}"
ENV_FILE="${ENV_FILE:-${PLUGIN_DIR}/.env}"
OPENCLAW_SERVICE="${OPENCLAW_SERVICE:-}"
OPENCLAW_USER="${OPENCLAW_USER:-}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

log() {
  printf '[install-biwenger-focus] %s\n' "$*"
}

fail() {
  printf '[install-biwenger-focus][ERROR] %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Run as root."
  fi
}

resolve_service() {
  if [[ -n "${OPENCLAW_SERVICE}" ]]; then
    return
  fi

  OPENCLAW_SERVICE="$(systemctl list-units --type=service --all | awk '/openclaw/{print $1; exit}')"
  [[ -n "${OPENCLAW_SERVICE}" ]] || fail "Could not detect OpenClaw systemd service. Set OPENCLAW_SERVICE=..."
}

resolve_user() {
  if [[ -n "${OPENCLAW_USER}" ]]; then
    return
  fi

  OPENCLAW_USER="$(systemctl show -p User --value "${OPENCLAW_SERVICE}")"
  [[ -n "${OPENCLAW_USER}" ]] || OPENCLAW_USER="root"
}

require_paths() {
  [[ -d "${PLUGIN_DIR}" ]] || fail "Plugin dir not found: ${PLUGIN_DIR}"
  [[ -d "${MCP_DIR}" ]] || fail "MCP dir not found: ${MCP_DIR}"
}

ensure_env() {
  [[ -f "${ENV_FILE}" ]] || fail "Missing env file: ${ENV_FILE}"

  local has_token has_email has_pwd has_league has_user has_league_alias has_user_alias
  has_token="$(grep -E '^BIWENGER_TOKEN=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  has_email="$(grep -E '^BIWENGER_EMAIL=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  has_pwd="$(grep -E '^BIWENGER_PASSWORD=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  has_league="$(grep -E '^BIWENGER_LEAGUE_ID=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  has_user="$(grep -E '^BIWENGER_USER_ID=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  has_league_alias="$(grep -E '^LEAGUE_ID=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  has_user_alias="$(grep -E '^USER_ID=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"

  if [[ -z "${has_token// }" ]]; then
    if [[ -z "${has_email// }" || -z "${has_pwd// }" ]]; then
      fail "Missing Biwenger credentials in ${ENV_FILE}. Use BIWENGER_TOKEN or BIWENGER_EMAIL+BIWENGER_PASSWORD."
    fi
  fi

  if [[ -z "${has_league// }" && -z "${has_league_alias// }" ]]; then
    fail "Missing BIWENGER_LEAGUE_ID (or LEAGUE_ID) in ${ENV_FILE}."
  fi

  if [[ -z "${has_user// }" && -z "${has_user_alias// }" ]]; then
    fail "Missing BIWENGER_USER_ID (or USER_ID) in ${ENV_FILE}."
  fi
}

build_mcp() {
  log "Installing and building biwenger-mcp..."
  cd "${MCP_DIR}"
  npm install
  npm run build
  [[ -f "${MCP_DIR}/dist/server.js" ]] || fail "Missing ${MCP_DIR}/dist/server.js after build"
}

build_plugin() {
  log "Installing and building biwenger-focus plugin..."
  cd "${PLUGIN_DIR}"
  npm install
  npm run build
  [[ -f "${PLUGIN_DIR}/dist/index.js" ]] || fail "Missing ${PLUGIN_DIR}/dist/index.js after build"
}

install_systemd_dropin() {
  local dropin_dir="/etc/systemd/system/${OPENCLAW_SERVICE}.d"
  local dropin_file="${dropin_dir}/10-biwenger-focus.conf"

  mkdir -p "${dropin_dir}"
  cat >"${dropin_file}" <<EOC
[Service]
EnvironmentFile=${ENV_FILE}
EOC
}

apply_permissions() {
  mkdir -p /var/lib/openclaw
  chown -R "${OPENCLAW_USER}:${OPENCLAW_USER}" "${PLUGIN_DIR}" /var/lib/openclaw
  chmod 600 "${ENV_FILE}"
}

restart_service() {
  log "Restarting ${OPENCLAW_SERVICE}..."
  systemctl daemon-reload
  systemctl restart "${OPENCLAW_SERVICE}"
  systemctl --no-pager --full status "${OPENCLAW_SERVICE}" | sed -n '1,25p'
}

verify_runtime() {
  log "Recent logs:"
  journalctl -u "${OPENCLAW_SERVICE}" -n 120 --no-pager | grep -Ei 'biwenger|focus|plugin|mcp' || true
}

main() {
  require_root
  require_cmd systemctl
  require_cmd npm
  require_cmd grep
  [[ -n "${NODE_BIN}" ]] || fail "node not found"

  resolve_service
  resolve_user
  require_paths
  ensure_env

  log "OPENCLAW_SERVICE=${OPENCLAW_SERVICE}"
  log "OPENCLAW_USER=${OPENCLAW_USER}"
  log "PLUGIN_DIR=${PLUGIN_DIR}"
  log "MCP_DIR=${MCP_DIR}"
  log "ENV_FILE=${ENV_FILE}"

  build_mcp
  build_plugin
  install_systemd_dropin
  apply_permissions
  restart_service
  verify_runtime

  log "Installation completed."
}

main "$@"
