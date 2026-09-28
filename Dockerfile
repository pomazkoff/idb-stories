# syntax=docker/dockerfile:1.7
# Образы сервиса сторис. Базовые образы закреплены по digest (раздел 10.10), обновляет Renovate.
# Цели: api, jobs, media, tools (миграции/seed/инициализация хранилища), admin.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.31-alpine-slim@sha256:c81a27f28bc2d9c2da8998444e653c7b85b9bbbaa92e44ef18d8920784e06507

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
# pnpm кладётся в образ на этапе сборки: в рантайме tools-контейнер ничего не скачивает.
# REDISMS_DISABLE_POSTINSTALL: redis-memory-server нужен только локальным тестам без Docker.
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true COREPACK_HOME=/corepack REDISMS_DISABLE_POSTINSTALL=1
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate && chmod -R a+rX /corepack
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline \
 && pnpm --filter "@idb-stories/api..." --filter "@idb-stories/worker..." run build \
 && pnpm --filter @idb-stories/admin run build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm deploy --legacy --filter @idb-stories/api --prod /out/api \
 && pnpm deploy --legacy --filter @idb-stories/worker --prod /out/worker

# Миграции, seed, инициализация хранилища: нужен Prisma CLI и tsx (dev-зависимости).
FROM build AS tools
USER node
CMD ["sh", "-c", "pnpm db:migrate && pnpm db:seed && pnpm --filter @idb-stories/api storage:init"]

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]

FROM runtime AS api
COPY --from=build --chown=root:root /out/api /app
EXPOSE 8080 8081 9464
CMD ["node", "dist/server.js"]

FROM runtime AS jobs
COPY --from=build --chown=root:root /out/worker /app
EXPOSE 9465
CMD ["node", "dist/jobs/main.js"]

# ---------------------------------------------------------------------------
# ffmpeg с минимальным набором компонентов (раздел 10.5): без сети, только mov-демуксер,
# декодеры H.264/HEVC/AAC/MP3, энкодеры libx264/AAC/PNG. Исходники проверяются по sha256.
FROM ${DEBIAN_IMAGE} AS ffmpeg
ARG FFMPEG_VERSION=7.1.5
ARG FFMPEG_SHA256=de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential nasm pkg-config libx264-dev zlib1g-dev curl ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN curl -fsSLo ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
 && tar xf ffmpeg.tar.xz --strip-components=1 \
 && ./configure --prefix=/opt/ffmpeg \
      --disable-everything --disable-network --disable-autodetect --disable-doc --disable-debug \
      --disable-ffplay --enable-gpl --enable-libx264 \
      --enable-protocol=file,pipe \
      --enable-demuxer=mov \
      --enable-muxer=mp4,image2 \
      --enable-decoder=h264,hevc,aac,mp3,mp3float \
      --enable-encoder=libx264,aac,png \
      --enable-parser=h264,hevc,aac,mpegaudio \
      --enable-bsf=h264_mp4toannexb,hevc_mp4toannexb,aac_adtstoasc \
      --enable-filter=scale,crop,split,setsar,format,null,anull,aresample,aformat,transpose,hflip,vflip,rotate \
      --enable-swscale --enable-swresample --enable-zlib \
 && make -j"$(nproc)" && make install

FROM runtime AS media
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libx264-164 zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=ffmpeg /opt/ffmpeg/bin/ffmpeg /opt/ffmpeg/bin/ffprobe /usr/local/bin/
COPY --from=build --chown=root:root /out/worker /app
USER node
# libvips: заблокировать «недоверенные» загрузчики на уровне библиотеки (дополнительно к sharp.block).
ENV VIPS_BLOCK_UNTRUSTED=1 FFMPEG_PATH=/usr/local/bin/ffmpeg FFPROBE_PATH=/usr/local/bin/ffprobe MEDIA_TMP_DIR=/tmp
EXPOSE 9465
CMD ["node", "dist/media/main.js"]

# ---------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS admin
COPY ops/nginx/admin.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
EXPOSE 8080
