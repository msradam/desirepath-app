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

# Spaces run the container as uid 1000.
RUN useradd -m -u 1000 user || true
ENV HOME=/home/user \
    OLLAMA_HOST=127.0.0.1:11434 \
    PORT=7860

WORKDIR /app
COPY --chown=user:user public/ /app/public/
COPY --chown=user:user server.mjs /app/server.mjs
COPY --chown=user:user start.sh /app/start.sh
RUN chmod +x /app/start.sh \
 && chown -R user:user /opt/ollama /app \
 && mkdir -p /home/user/.ollama && chown -R user:user /home/user

USER user
EXPOSE 7860

# The base image sets an entrypoint of /bin/ollama; we need a shell instead.
ENTRYPOINT []
CMD ["/app/start.sh"]
