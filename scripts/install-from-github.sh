#!/usr/bin/env bash
set -euo pipefail

PLUGIN_REPO_URL="${PLUGIN_REPO_URL:-}"
PLUGIN_REPO_REF="${PLUGIN_REPO_REF:-main}"
PLUGIN_DIR="${PLUGIN_DIR:-/opt/openclaw/plugins/biwenger-focus}"
MCP_DIR="${MCP_DIR:-/opt/biwenger-mcp}"
MCP_REPO_URL="${MCP_REPO_URL:-}"
ENV_FILE="${ENV_FILE:-${PLUGIN_DIR}/.env}"

log() {
  printf '[install-from-github] %s\n' "$*"
}

fail() {
  printf '[install-from-github][ERROR] %s\n' "$*" >&2
  exit 1
}

require_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    fail "Run as root."
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing command: $1"
}

clone_or_update() {
  local repo_url="$1"
  local ref="$2"
  local target_dir="$3"

  if [[ -d "${target_dir}/.git" ]]; then
    log "Updating ${target_dir} (${ref})..."
    git -C "${target_dir}" fetch --all --tags
    git -C "${target_dir}" checkout "${ref}"
    git -C "${target_dir}" pull --ff-only origin "${ref}" || true
  else
    log "Cloning ${repo_url} -> ${target_dir} (${ref})..."
    rm -rf "${target_dir}"
    git clone --branch "${ref}" --depth 1 "${repo_url}" "${target_dir}"
  fi
}

main() {
  require_root
  require_cmd git
  require_cmd bash

  [[ -n "${PLUGIN_REPO_URL}" ]] || fail "Set PLUGIN_REPO_URL=https://github.com/<org>/<repo>.git"

  mkdir -p "$(dirname "${PLUGIN_DIR}")"
  clone_or_update "${PLUGIN_REPO_URL}" "${PLUGIN_REPO_REF}" "${PLUGIN_DIR}"

  if [[ -n "${MCP_REPO_URL}" ]]; then
    mkdir -p "$(dirname "${MCP_DIR}")"
    clone_or_update "${MCP_REPO_URL}" "main" "${MCP_DIR}"
  fi

  if [[ ! -f "${ENV_FILE}" ]]; then
    if [[ -f "${PLUGIN_DIR}/.env.example" ]]; then
      cp "${PLUGIN_DIR}/.env.example" "${ENV_FILE}"
      log "Created ${ENV_FILE} from .env.example. Edit it before rerunning installer."
      fail "Missing required secrets in ${ENV_FILE}. Fill and rerun."
    else
      fail "Missing ${ENV_FILE} and no .env.example found."
    fi
  fi

  log "Executing installer..."
  PLUGIN_DIR="${PLUGIN_DIR}" MCP_DIR="${MCP_DIR}" ENV_FILE="${ENV_FILE}" \
    bash "${PLUGIN_DIR}/scripts/install-biwenger-focus.sh"
}

main "$@"
