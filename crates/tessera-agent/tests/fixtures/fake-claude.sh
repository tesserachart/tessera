#!/bin/sh
dir=$(dirname "$0")
log=$1
mode=$2
shift 2
{
  echo "-- invocation"
  for a in "$@"; do printf '%s\n' "$a"; done
  echo "CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-}"
  env | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/ENV \1/p' | sort
} >>"$log"
case "$1" in
--version)
  echo "2.1.289 (Claude Code)"
  exit 0
  ;;
auth)
  if [ "$2" = login ]; then
    echo "Opening browser to sign in…"
    echo "If the browser didn't open, visit: https://claude.invalid/oauth/authorize?code=true&state=s"
    printf 'Paste code here if prompted > '
    IFS= read -r code
    [ -n "$code" ] || exit 1
    echo "-- code $code" >>"$log"
    : >"$CLAUDE_CONFIG_DIR/.signed-in"
    echo "Login successful."
    exit 0
  fi
  if [ "$mode" = signed-out ] && [ ! -e "$CLAUDE_CONFIG_DIR/.signed-in" ]; then
    echo '{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}'
    exit 1
  fi
  echo '{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}'
  exit 0
  ;;
esac
# the conversation's id, as the real CLI echoes it in every frame
session=
prev=
for a in "$@"; do
  case "$prev" in --session-id | --resume) session=$a ;; esac
  prev=$a
done
if [ "$mode" = lost ]; then
  for a in "$@"; do
    if [ "$a" = --resume ]; then
      echo "No conversation found with session ID: $session" >&2
      exit 1
    fi
  done
fi
replay() {
  if [ -n "$session" ]; then sed "s/0199c0de-0000-7000-8000-00000000000[0-9]/$session/g" "$1"; else cat "$1"; fi
}
while IFS= read -r line; do
  case "$mode:$line" in
  deaf:*'"subtype":"interrupt"'*) : ;;
  *'"subtype":"interrupt"'*)
    echo "-- interrupted" >>"$log"
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Request was aborted"],"terminal_reason":"aborted_streaming","uuid":"r"}'
    ;;
  steer:*'"priority":"now"'*)
    echo "-- steer" >>"$log"
    printf '%s\n' "$line" >>"$log.stdin"
    echo '{"type":"result","subtype":"success","is_error":false,"terminal_reason":"aborted_streaming","result":"","uuid":"r"}'
    replay "$dir/claude-turn.jsonl"
    ;;
  *'"type":"user"'*)
    echo "-- message" >>"$log"
    printf '%s\n' "$line" >>"$log.stdin"
    case "$mode" in
    signed-out) replay "$dir/claude-signed-out.jsonl" ;;
    hang | steer | deaf) replay "$dir/claude-turn.jsonl" | head -n 7 ;;
    *) replay "$dir/claude-turn.jsonl" ;;
    esac
    ;;
  esac
done
