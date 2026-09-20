#!/bin/sh
# Bake the model into the image at build time.
set -e

mkdir -p "$OLLAMA_MODELS"

ollama serve &
SERVER_PID=$!

i=0
until curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    echo "ollama did not come up within 120s"
    exit 1
  fi
  sleep 1
done

ollama pull granite4:micro

# Stop it by PID, not by pattern.
#
# `pkill -f "ollama serve"` matches this script's own command line inside the
# Docker build, so it SIGTERMs the build step and the layer fails with exit
# 143 immediately after a successful pull, which reads like the pull failed.
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true

# Give the manifest write a moment to flush before the layer is committed.
sleep 2
exit 0
