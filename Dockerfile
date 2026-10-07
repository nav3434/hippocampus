# Build stage
FROM node:20-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ git && rm -rf /var/lib/apt/lists/*

# onnxruntime-node (pulled in by @huggingface/transformers) special-cases linux/x64:
# its postinstall auto-downloads the CUDA/TensorRT GPU provider binaries from NuGet
# during `npm ci`. This VPS is CPU-only — all-MiniLM-L6-v2 runs on the bundled CPU
# binary — so skip that download. Without this, `npm ci` pulls hundreds of MB and
# fails outright if the NuGet feed is unreachable. (No-op on non-linux/x64 hosts.)
ENV ONNXRUNTIME_NODE_INSTALL=skip

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# Separate client-only image for the Personal Reflection acceptance runner.
# It reuses builder dependencies (including tsx) but does not copy the server,
# application source, build tools, or production runtime configuration.
FROM node:20-slim AS personal-reflection-acceptance

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY scripts/personal-reflection-production-acceptance.ts ./scripts/personal-reflection-production-acceptance.ts
COPY scripts/personal-reflection-acceptance-core.ts ./scripts/personal-reflection-acceptance-core.ts

CMD ["npm", "run", "acceptance:personal-reflection"]

# Production stage
FROM node:20-slim AS production

WORKDIR /app

# Install runtime dependencies for better-sqlite3-multiple-ciphers
RUN apt-get update && apt-get install -y openssl curl && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -g 1001 hippo && \
    useradd -u 1001 -g hippo -s /bin/false hippo

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

# Create data directory
RUN mkdir -p /data && chown hippo:hippo /data

USER hippo

ENV NODE_ENV=production
ENV HIPPO_DB_PATH=/data/hippocampus.db
ENV TRANSFORMERS_CACHE=/data/.models
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]

# Same production backend image/source, with only immutable source identity
# metadata for the isolated acceptance report. Runtime hooks remain disabled
# unless the isolated Compose file sets its guarded mode explicitly.
FROM production AS personal-reflection-acceptance-backend
ARG HIPPO_BUILD_SHA
ENV HIPPO_BUILD_SHA=${HIPPO_BUILD_SHA}
ENV TRANSFORMERS_CACHE=/opt/transformers-cache
USER root
RUN mkdir -p /opt/transformers-cache && chown hippo:hippo /opt/transformers-cache
USER hippo
# Warm the exact production model into the acceptance image so a fresh isolated
# data volume needs no model download and remains dedicated to synthetic data.
RUN node --input-type=module -e "import { pipeline } from '@huggingface/transformers'; await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8', cache_dir: process.env.TRANSFORMERS_CACHE });"
