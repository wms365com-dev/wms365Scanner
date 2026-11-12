FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY ops/backup/package.json ops/backup/package-lock.json ./
RUN npm ci --omit=dev

FROM postgres:18-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=dependencies /app/node_modules ./node_modules
COPY ops/backup/package.json ops/backup/package-lock.json ./
COPY ops/backup/src ./src

COPY . /workspace/source

RUN node --version && pg_dump --version && pg_restore --version

RUN useradd --create-home --uid 10001 backup \
    && chown -R backup:backup /app /workspace
USER backup

ENV BACKUP_CODE_ROOT=/workspace/source
CMD ["node", "src/backup.js"]
