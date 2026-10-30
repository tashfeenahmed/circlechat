# MinIO server built from the archived upstream source. MinIO stopped
# publishing community images (quay.io and Docker Hub answer 401) and
# dl.min.io returns 410 for every release, so a fresh `docker compose up`
# can no longer pull it. We build the same release tag ourselves and publish
# it to ghcr.io/tashfeenahmed/circlechat-minio (see .github/workflows/images.yml).
ARG MINIO_RELEASE=RELEASE.2025-09-07T16-13-09Z

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG MINIO_RELEASE
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git /src
WORKDIR /src
RUN LDFLAGS="$(MINIO_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -tags kqueue -trimpath -ldflags "$LDFLAGS" -o /out/minio

FROM alpine:3.22
ARG MINIO_RELEASE
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /usr/bin/minio
LABEL org.opencontainers.image.source="https://github.com/tashfeenahmed/circlechat" \
      org.opencontainers.image.description="MinIO ${MINIO_RELEASE} built from archived upstream source" \
      org.opencontainers.image.version="${MINIO_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0"
EXPOSE 9000
VOLUME ["/data"]
# Same contract as the upstream image for compose's `command: server /data ...`.
ENTRYPOINT ["minio"]
CMD ["server", "/data"]
