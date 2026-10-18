#!/usr/bin/env bash
#
# deploy.sh — bring up the full erp-next stack (Frappe Bench + hosting platform).
#
# It validates that `.env` is production-ready and, when values are missing or
# still placeholders, either asks you for them interactively or auto-generates
# secrets before the services are started.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
ENV_EXAMPLE="$ROOT_DIR/.env.example"
COMPOSE_FILE="$ROOT_DIR/docker-compose.yml"

AUTO=0
ASSUME_YES=0
DRY_RUN=0
FORCE=0
DO_BUILD=1
ALLOW_INSECURE=0
FOLLOW_LOGS=0
ACTION="up"

GEN_KEYS=(SESSION_COOKIE_SECRET PLATFORM_DB_PASSWORD MARIADB_ROOT_PASSWORD ERPNEXT_ADMIN_PASSWORD BACKUP_CREDENTIALS_ENCRYPTION_KEY)
INPUT_KEYS=(PUBLIC_BASE_URL TRUEMOI_CLIENT_ID TRUEMOI_AUTH_DOMAIN PROVISIONING_BASE_DOMAIN)

PROBLEM_GEN=()
PROBLEM_INPUT=()
WARNINGS=()

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[err ]\033[0m %s\n' "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [options]

Validates .env for production and deploys the full stack (Frappe Bench + platform).

Options:
  -a, --auto            Auto-generate secrets; prompt only for the rest
  -y, --yes             Non-interactive: skip the final confirmation
      --force           Regenerate all secrets (rotates credentials)
      --dry-run, --check  Validate and print the plan; write/start nothing
      --no-build        Skip rebuilding images
      --allow-insecure  Permit an http:// PUBLIC_BASE_URL (trusted staging only)
      --logs            Follow platform-api/platform-worker logs after deploying
      --down            Stop the stack and exit
  -h, --help            Show this help

Interactive (default): when values are missing it offers to auto-generate the
secrets and asks you for the required non-secret values before starting.
EOF
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    -a|--auto)          AUTO=1 ;;
    -y|--yes)           ASSUME_YES=1 ;;
    --dry-run|--check)  DRY_RUN=1 ;;
    --force)            FORCE=1 ;;
    --no-build)         DO_BUILD=0 ;;
    --allow-insecure)   ALLOW_INSECURE=1 ;;
    --logs)             FOLLOW_LOGS=1 ;;
    --down)             ACTION="down" ;;
    -h|--help)          usage ;;
    *) die "Unknown option: $arg (use --help)" ;;
  esac
done

# ── Prerequisites ───────────────────────────────────────────────────────────
check_prereqs() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
  docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) is required"
  docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running?)"
  [[ -f "$COMPOSE_FILE" ]] || die "missing $COMPOSE_FILE"
}

# ── .env helpers (not sourced: values may contain shell-significant chars) ──
ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ENV_EXAMPLE" ]] || die "missing $ENV_EXAMPLE"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    log "Created .env from .env.example"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

get_env() {
  local key="$1" line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -n1 || true)"
  printf '%s' "${line#*=}"
}

set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  grep -vE "^${key}=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$key" "$value" >>"$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

gen_secret() {
  local bytes="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr -d '\n='
  else
    head -c "$bytes" /dev/urandom | base64 | tr -d '\n='
  fi
}

is_placeholder() {
  case "$1" in
    ""|change-me*|your-truemoi-client-id|your-truemoi-client-secret|\
    change-me-to-a-long-random-secret-value-000000|apps.example.com) return 0 ;;
    *) return 1 ;;
  esac
}

# ── Validation ──────────────────────────────────────────────────────────────
validate() {
  PROBLEM_GEN=()
  PROBLEM_INPUT=()
  WARNINGS=()
  local key v min decoded_bytes canonical_key

  for key in "${GEN_KEYS[@]}"; do
    v="$(get_env "$key")"
    min=12
    if [[ "$key" == "SESSION_COOKIE_SECRET" ]]; then min=32; fi
    if [[ "$key" == "BACKUP_CREDENTIALS_ENCRYPTION_KEY" ]]; then
      decoded_bytes="$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c | tr -d ' ' || true)"
      canonical_key="$(printf '%s' "$v" | base64 -d 2>/dev/null | base64 2>/dev/null | tr -d '\n' || true)"
      if [[ $FORCE -eq 1 ]] || is_placeholder "$v" || [[ "$decoded_bytes" != "32" ]] || [[ "$canonical_key" != "$v" ]]; then
        PROBLEM_GEN+=("$key")
      fi
      continue
    fi
    if [[ $FORCE -eq 1 ]] || is_placeholder "$v" || (( ${#v} < min )); then
      PROBLEM_GEN+=("$key")
    fi
  done

  for key in "${INPUT_KEYS[@]}"; do
    v="$(get_env "$key")"
    if is_placeholder "$v"; then
      PROBLEM_INPUT+=("$key")
    fi
  done

  v="$(get_env PUBLIC_BASE_URL)"
  if [[ -n "$v" && "$v" != https://* && $ALLOW_INSECURE -eq 0 ]]; then
    die "PUBLIC_BASE_URL must use https:// in production (got '$v'). Re-run with --allow-insecure to override."
  fi

  if [[ -z "$(get_env TRUEMOI_CLIENT_SECRET)" ]]; then
    WARNINGS+=("TRUEMOI_CLIENT_SECRET is empty — fine for a public client, required for a confidential one.")
  fi
  if [[ -z "$(get_env ADMIN_EMAILS)" && "$(get_env TRUEMOI_ADMIN_ROLES)" == "platform-admin,admin" ]]; then
    WARNINGS+=("Set ADMIN_EMAILS (or TRUEMOI_ADMIN_ROLES) so you have a bootstrap platform admin.")
  fi
}

describe_input() {
  case "$1" in
    PUBLIC_BASE_URL)          echo "Public HTTPS origin of the platform (e.g. https://erp.example.com)" ;;
    TRUEMOI_CLIENT_ID)        echo "Truemoi OAuth client id" ;;
    TRUEMOI_AUTH_DOMAIN)      echo "Truemoi auth domain (e.g. auth.truemoi.com)" ;;
    PROVISIONING_BASE_DOMAIN) echo "Base domain for customer sites (e.g. apps.example.com)" ;;
    *) echo "$1" ;;
  esac
}

# ── Provisioning ────────────────────────────────────────────────────────────
auto_generate() {
  local key
  for key in "${PROBLEM_GEN[@]}"; do
    if [[ "$key" == "BACKUP_CREDENTIALS_ENCRYPTION_KEY" ]]; then
      local encryption_key
      if command -v openssl >/dev/null 2>&1; then
        encryption_key="$(openssl rand -base64 32 | tr -d '\n')"
      else
        encryption_key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
      fi
      set_env "$key" "$encryption_key"
    elif [[ "$key" == "SESSION_COOKIE_SECRET" ]]; then
      set_env "$key" "$(gen_secret 48)"
    else
      set_env "$key" "$(gen_secret 24)"
    fi
    log "Generated $key"
  done
  PROBLEM_GEN=()
}

prompt_inputs() {
  local key answer
  if [[ ${#PROBLEM_INPUT[@]} -eq 0 ]]; then return 0; fi
  [[ -t 0 ]] || die "Missing values (${PROBLEM_INPUT[*]}) and no TTY to prompt on. Set them in .env or export them."
  for key in "${PROBLEM_INPUT[@]}"; do
    answer=""
    while [[ -z "$answer" ]]; do
      read -rp "$(describe_input "$key"): " answer || true
      if [[ -z "$answer" ]]; then warn "A value is required for $key"; fi
    done
    set_env "$key" "$answer"
  done
  PROBLEM_INPUT=()
}

prompt_generated() {
  local key answer
  if [[ ${#PROBLEM_GEN[@]} -eq 0 ]]; then return 0; fi
  for key in "${PROBLEM_GEN[@]}"; do
    answer=""
    while [[ -z "$answer" ]]; do
      read -rsp "Enter value for $key (input hidden): " answer; echo
      if [[ -z "$answer" ]]; then warn "A value is required for $key"; fi
    done
    set_env "$key" "$answer"
  done
  PROBLEM_GEN=()
}

provision() {
  local total=$(( ${#PROBLEM_GEN[@]} + ${#PROBLEM_INPUT[@]} ))
  if [[ $total -eq 0 ]]; then return 0; fi

  if [[ $AUTO -eq 1 ]]; then
    auto_generate
    prompt_inputs
    FORCE=0
    return 0
  fi

  if [[ ! -t 0 ]]; then
    if (( ${#PROBLEM_INPUT[@]} > 0 )); then
      die "Not production-ready and no TTY to prompt. Missing: ${PROBLEM_INPUT[*]}. Set them in .env, then re-run with --auto."
    fi
    auto_generate
    FORCE=0
    return 0
  fi

  printf '\nThe following values need attention:\n'
  if [[ ${#PROBLEM_GEN[@]} -gt 0 ]];   then printf '  - %s\n' "${PROBLEM_GEN[@]}"; fi
  if [[ ${#PROBLEM_INPUT[@]} -gt 0 ]]; then printf '  - %s\n' "${PROBLEM_INPUT[@]}"; fi
  cat <<'EOF'

How do you want to provision them?
  1) Auto-generate secrets, then prompt for the rest (recommended)
  2) Enter every value interactively
  3) Abort
EOF
  local choice=""
  read -rp "Choose [1]: " choice
  case "${choice:-1}" in
    1) auto_generate; prompt_inputs ;;
    2) prompt_generated; prompt_inputs ;;
    3) die "Aborted by user" ;;
    *) warn "Invalid choice"; provision; return ;;
  esac
  FORCE=0
}

# ── Production hardening of derived values ──────────────────────────────────
apply_derived_defaults() {
  local base
  base="$(get_env PUBLIC_BASE_URL)"
  if [[ "$(get_env NODE_ENV)" != "production" ]]; then set_env NODE_ENV production; log "Set NODE_ENV=production"; fi
  if [[ "$base" == https://* ]]; then
    if [[ "$(get_env COOKIE_SECURE)" != "true" ]]; then set_env COOKIE_SECURE true; log "Set COOKIE_SECURE=true"; fi
  else
    if [[ "$(get_env COOKIE_SECURE)" != "false" ]]; then set_env COOKIE_SECURE false; log "Set COOKIE_SECURE=false (insecure origin)"; fi
  fi
  if [[ -z "$(get_env COMPOSE_PROJECT_NAME)" ]];   then set_env COMPOSE_PROJECT_NAME erpnext; fi
  if [[ -z "$(get_env ERPNEXT_VERSION)" ]];        then set_env ERPNEXT_VERSION v16.51.1; fi
  if [[ -z "$(get_env PLATFORM_API_PORT)" ]];      then set_env PLATFORM_API_PORT 3000; fi
  if [[ -z "$(get_env FRAPPE_HTTP_PORT)" ]];       then set_env FRAPPE_HTTP_PORT 8080; fi
  if [[ -z "$(get_env PLATFORM_DB_PORT)" ]];       then set_env PLATFORM_DB_PORT 5432; fi
}

port_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | grep -q ":$port "
  else
    return 1
  fi
}

check_ports() {
  local var port
  for var in PLATFORM_API_PORT FRAPPE_HTTP_PORT PLATFORM_DB_PORT; do
    port="$(get_env "$var")"
    if [[ -z "$port" ]]; then continue; fi
    if port_in_use "$port"; then
      WARNINGS+=("Host port $port ($var) is already in use; Compose will fail unless it belongs to this stack. Change $var in .env.")
    fi
  done
}

print_warnings() {
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    printf '\n'
    warn "Review before going live:"
    printf '  - %s\n' "${WARNINGS[@]}" >&2
  fi
}

summary() {
  printf '\n\033[1mDeployment summary\033[0m\n'
  printf '  %-24s %s\n' "Project name:"      "$(get_env COMPOSE_PROJECT_NAME)"
  printf '  %-24s %s\n' "Public base URL:"   "$(get_env PUBLIC_BASE_URL)"
  printf '  %-24s %s\n' "Platform API:"      "http://localhost:$(get_env PLATFORM_API_PORT)"
  printf '  %-24s %s\n' "Frappe ingress:"    "http://localhost:$(get_env FRAPPE_HTTP_PORT)"
  printf '  %-24s %s\n' "Sites base domain:" "$(get_env PROVISIONING_BASE_DOMAIN)"
  printf '  %-24s %s\n' "ERPNext version:"   "$(get_env ERPNEXT_VERSION)"
  printf '  %-24s %s\n' "Routing mode:"      "$(get_env PROVISION_ROUTING_MODE)"
  print_warnings
  printf '\n'
}

wait_for_api() {
  command -v curl >/dev/null 2>&1 || return 0
  local port url deadline
  port="$(get_env PLATFORM_API_PORT)"
  url="http://localhost:${port}/login"
  deadline=$(( SECONDS + 180 ))
  log "Waiting for the platform API at $url ..."
  until curl -fsS -o /dev/null "$url" 2>/dev/null; do
    if (( SECONDS >= deadline )); then
      warn "API did not become ready within 180s; check 'docker compose logs platform-api'."
      return 0
    fi
    sleep 3
  done
  ok "Platform API is up: $url"
}

# ── Main ────────────────────────────────────────────────────────────────────
main() {
  check_prereqs
  ensure_env_file

  if [[ "$ACTION" == "down" ]]; then
    log "Stopping the stack ..."
    docker compose --env-file "$ENV_FILE" down
    ok "Stack stopped."
    return 0
  fi

  validate

  if [[ $DRY_RUN -eq 1 ]]; then
    if (( ${#PROBLEM_GEN[@]} + ${#PROBLEM_INPUT[@]} > 0 )); then
      warn "Environment is NOT production-ready. Would provision:"
      if [[ ${#PROBLEM_GEN[@]} -gt 0 ]];   then printf '  - auto-generate: %s\n' "${PROBLEM_GEN[@]}" >&2; fi
      if [[ ${#PROBLEM_INPUT[@]} -gt 0 ]]; then printf '  - prompt for:    %s\n' "${PROBLEM_INPUT[@]}" >&2; fi
      print_warnings
      printf '\n' >&2
    else
      summary
      ok "Environment is production-ready."
    fi
    log "Dry run: no changes written, no containers started."
    return 0
  fi

  if (( ${#PROBLEM_GEN[@]} + ${#PROBLEM_INPUT[@]} > 0 )); then
    log "Environment is not production-ready yet."
    provision
  fi

  apply_derived_defaults
  validate
  check_ports

  if (( ${#PROBLEM_GEN[@]} + ${#PROBLEM_INPUT[@]} > 0 )); then
    die "Still missing required values: ${PROBLEM_GEN[*]} ${PROBLEM_INPUT[*]}"
  fi

  summary
  ok "Environment is production-ready."

  if [[ $ASSUME_YES -eq 0 && -t 0 ]]; then
    local reply=""
    read -rp "Deploy the full stack now? [Y/n] " reply
    case "${reply:-y}" in [Nn]*) die "Cancelled by user" ;; esac
  fi

  local args=(--env-file "$ENV_FILE" up -d)
  if [[ $DO_BUILD -eq 1 ]]; then args+=(--build); fi

  log "Starting stack (docker compose ${args[*]}) ..."
  docker compose "${args[@]}"

  wait_for_api
  log "Current containers:"
  docker compose --env-file "$ENV_FILE" ps
  ok "Deployed. Platform API: http://localhost:$(get_env PLATFORM_API_PORT)"

  if [[ $FOLLOW_LOGS -eq 1 ]]; then
    docker compose --env-file "$ENV_FILE" logs -f platform-api platform-worker
  fi
}

main
