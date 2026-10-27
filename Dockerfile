FROM oven/bun:1.4.3@sha256:ec06c3b6cea04192ae6770c434f668ca41d343ad19fa6472216c7b48be39c598 AS build
WORKDIR /src
COPY package.json bun.lock tsconfig.base.json ./
COPY packages ./packages
COPY sidecar ./sidecar
COPY ui ./ui
COPY scripts ./scripts
RUN bun install --frozen-lockfile
RUN bun run build:cli linux-x64-baseline

FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS runtime
ARG CODEX_VERSION=0.162.1
ARG CLAUDE_VERSION=2.1.296
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg git python3 procps util-linux tini xvfb xauth \
    fonts-dejavu-core fonts-liberation fonts-noto-color-emoji \
    && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
    > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@${CODEX_VERSION} @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && npm cache clean --force
COPY --from=build --chmod=755 /src/dist/touri-linux-x64-baseline /usr/local/bin/touri
COPY --chmod=755 docs/self-host/entrypoint.sh /usr/local/bin/touri-entrypoint
RUN mkdir -p /data/home && chown -R node:node /data && chmod 700 /data /data/home
ENV HOME=/data/home TOURI_CHROME_BIN=/usr/bin/google-chrome-stable
USER 1000:1000
WORKDIR /data
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/touri-entrypoint"]
CMD ["serve", "--host", "127.0.0.1", "--port", "8795", "--trust-proxy", "--data-dir", "/data", "--no-pair", "--drain-timeout", "60"]
