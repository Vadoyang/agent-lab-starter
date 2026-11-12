#!/usr/bin/env bash
# AgentLab one-line installer for Linux (Ubuntu/Debian).
# Downloads the kit from GitHub into ~/agent-lab-starter, then runs install.sh.
#
#   curl -fsSL https://raw.githubusercontent.com/Vadoyang/agent-lab-starter/main/get.sh | bash
#   # with install.sh options, for example the model server on a DGX:
#   curl -fsSL https://raw.githubusercontent.com/Vadoyang/agent-lab-starter/main/get.sh | bash -s -- --ollama point --model-url http://192.168.1.50:11434
#
# Running it again updates the code and keeps .env, logs, results, jobs and certificates.
# Environment overrides: AGENTLAB_REPO, AGENTLAB_REF (branch/tag), AGENTLAB_DIR,
#                        AGENTLAB_ARCHIVE_URL (mirror/test), AGENTLAB_DOWNLOAD_ONLY=1.
set -euo pipefail

REPO="${AGENTLAB_REPO:-Vadoyang/agent-lab-starter}"
REF="${AGENTLAB_REF:-main}"
DIR="${AGENTLAB_DIR:-$HOME/agent-lab-starter}"
URL="${AGENTLAB_ARCHIVE_URL:-https://github.com/$REPO/archive/$REF.tar.gz}"

say() { printf '\033[36m[agentlab]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[agentlab] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null || die "curl is not installed (sudo apt-get install -y curl)."
command -v tar  >/dev/null || die "tar is not installed."
say "AgentLab installer: repo $REPO, ref $REF, folder $DIR"

if [ -d "$DIR/.git" ]; then
  # A git clone is the maintainer copy: never overwrite it.
  say "$DIR is a git clone; updating with 'git pull --ff-only'."
  git -C "$DIR" pull --ff-only || die "git pull failed (local changes?). Nothing was overwritten."
else
  tmp="$(mktemp -d)"
  say "Downloading $URL"
  curl -fsSL --retry 3 --retry-delay 5 "$URL" -o "$tmp/kit.tar.gz" \
    || { rm -rf "$tmp"; die "Cannot download. Check the internet connection and that $REPO is public with branch/tag '$REF'."; }
  tar -xzf "$tmp/kit.tar.gz" -C "$tmp"
  top="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$top" ] && [ -f "$top/install.sh" ] || { rm -rf "$tmp"; die "The archive does not look like the AgentLab kit."; }
  mkdir -p "$DIR"
  # Overwrite code only; .env, logs, results, jobs and certificates are not in the archive and survive.
  cp -a "$top/." "$DIR/"
  rm -rf "$tmp"
  printf '{"repo":"%s","ref":"%s","archive":"%s","downloaded_at":"%s"}\n' \
    "$REPO" "$REF" "$URL" "$(date -Is)" > "$DIR/.source.json"
fi

cd "$DIR"
chmod +x install.sh lab.sh uninstall.sh get.sh 2>/dev/null || true
if [ "${AGENTLAB_DOWNLOAD_ONLY:-0}" = "1" ]; then
  say "Download only: kit is in $DIR. To install: cd $DIR && ./install.sh"
  exit 0
fi

say "Starting install.sh ..."
# Under "curl | bash" stdin is the script itself, so give install.sh the terminal for its questions.
if [ -t 0 ]; then
  exec ./install.sh "$@"
elif ( : </dev/tty ) 2>/dev/null; then
  exec ./install.sh "$@" </dev/tty
else
  say "No terminal available: running non-interactively (--yes)."
  exec ./install.sh --yes "$@"
fi
