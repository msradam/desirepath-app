#!/bin/sh
# Ollama in the background, the app in the foreground on the port Spaces expect.
set -e

ollama serve &

# Wait for the daemon rather than racing it. A Space that starts serving before
# the model is loadable answers its first queries with "Ollama unreachable".
i=0
until curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    echo "ollama did not come up within 120s; serving the app anyway so the"
    echo "coverage screen still works and the router can fall back to WebGPU."
    break
  fi
  sleep 1
done

# Resident before the first visitor, so nobody pays the load.
curl -sf http://127.0.0.1:11434/api/generate \
  -d '{"model":"granite4:micro","keep_alive":"-1"}' >/dev/null 2>&1 || true

exec node /app/server.mjs
