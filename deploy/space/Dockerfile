# DesirePath on a HuggingFace Docker Space.
#
# The static Space served files and made every visitor download a 900 MB model
# into their browser before the router would answer anything. This one runs the
# model on the Space instead, so the first query is fast and nothing is
# downloaded.
#
# The trade is real and is stated in the interface: with server inference the
# typed sentence reaches this container. The in-browser path is still here and
# is still private; ?llm=webgpu selects it.
FROM ollama/ollama:latest

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg procps \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# Granite 4 micro, baked into the image rather than pulled on boot. A Space
# that downloads 2.1 GB at startup looks broken for the first few minutes and
# does it again on every restart.
ENV OLLAMA_MODELS=/opt/ollama/models
COPY pull-model.sh /tmp/pull-model.sh
RUN chmod +x /tmp/pull-model.sh && /tmp/pull-model.sh && rm /tmp/pull-model.sh

# Spaces run the container as uid 1000, and everything below refers to that
# uid numerically rather than by name. The ollama base image already has a user
# at 1000 under a different name, so `useradd -u 1000 user` fails, `|| true`
# swallows it, and every later `chown user:user` dies with "invalid user".
ENV HOME=/home/user \
    OLLAMA_HOST=127.0.0.1:11434 \
    OLLAMA_ORIGINS=http://127.0.0.1:*,http://localhost:* \
    PORT=7860

WORKDIR /app
COPY --chown=1000:1000 public/ /app/public/
COPY --chown=1000:1000 server.mjs /app/server.mjs
COPY --chown=1000:1000 start.sh /app/start.sh
RUN chmod +x /app/start.sh \
 && mkdir -p /home/user/.ollama \
 && chown -R 1000:1000 /opt/ollama /app /home/user

USER 1000
EXPOSE 7860

# The base image sets an entrypoint of /bin/ollama; we need a shell instead.
ENTRYPOINT []
CMD ["/app/start.sh"]
