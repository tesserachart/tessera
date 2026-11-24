#!/usr/bin/env bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-}"
if [ -z "$root" ]; then
  root="$(cd "$(dirname "$0")/.." && pwd)"
fi
cd "$root"

export PATH="${HOME}/.cargo/bin:${HOME}/.bun/bin:${PATH}"

apt_pkgs=(
  build-essential
  ca-certificates
  curl
  libayatana-appindicator3-dev
  libgtk-3-dev
  libjavascriptcoregtk-4.1-dev
  librsvg2-dev
  libsoup-3.0-dev
  libssl-dev
  libwebkit2gtk-4.1-dev
  patchelf
  pkg-config
  unzip
)

need_apt=()
for pkg in "${apt_pkgs[@]}"; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    need_apt+=("$pkg")
  fi
done

if [ "${#need_apt[@]}" -gt 0 ]; then
  if [ "$(id -u)" -eq 0 ]; then
    apt-get update -q
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${need_apt[@]}"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo apt-get update -q
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${need_apt[@]}"
  else
    printf 'cloud-session-setup: missing apt packages and no root: %s\n' "${need_apt[*]}" >&2
  fi
fi

if ! command -v rustup >/dev/null 2>&1; then
  curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none --profile minimal
fi
if [ -f "${HOME}/.cargo/env" ]; then
  . "${HOME}/.cargo/env"
fi
export PATH="${HOME}/.cargo/bin:${PATH}"
rustup toolchain install
rustup component add rustfmt clippy
rustup default stable

if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export PATH="${HOME}/.bun/bin:${PATH}"
fi

if ! command -v cargo-nextest >/dev/null 2>&1; then
  mkdir -p "${HOME}/.cargo/bin"
  curl -LsSf https://get.nexte.st/0.9.150/linux | tar zxf - -C "${HOME}/.cargo/bin"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  printf 'export PATH=%s/.cargo/bin:%s/.bun/bin:$PATH\n' "$HOME" "$HOME" >> "$CLAUDE_ENV_FILE"
fi

printf 'cloud-session-setup: rust=%s bun=%s nextest=%s\n' \
  "$(rustc --version 2>/dev/null || echo missing)" \
  "$(bun --version 2>/dev/null || echo missing)" \
  "$(cargo nextest --version 2>/dev/null || echo missing)"
