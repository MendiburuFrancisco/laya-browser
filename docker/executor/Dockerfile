FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    EXECUTOR_HOST=0.0.0.0 \
    EXECUTOR_PORT=8787 \
    EXECUTOR_DATA_DIR=/data/executor

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && npm cache clean --force

COPY src ./src
COPY bin/laya-test-executor.mjs bin/laya-test-runner.mjs ./bin/
RUN mkdir -p /data/executor /tmp/laya-executor \
    && chown -R node:node /app /data/executor /tmp/laya-executor

USER node
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/laya-test-executor.mjs"]
