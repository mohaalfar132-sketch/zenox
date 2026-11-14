# ZENOX production image: server + exported web app + a terminal workspace.
# Two stages keep TypeScript/Expo tooling out of the runtime image.

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1 EXPO_NO_TELEMETRY=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
# The terminal, the APK build and `git apply` all expect these on the server.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN NODE_ENV=production pnpm build && pnpm build:web

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 ZENOX_DATA_DIR=/data COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl bash \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Runtime needs the built server, the built web app, and the tool scripts the
# owner assistant runs (build-apk, migrations, smoke checks).
COPY --from=build /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/android-app ./android-app
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/shared ./shared

RUN mkdir -p /data/uploads /data/chats && chown -R node:node /data /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/index.js"]
