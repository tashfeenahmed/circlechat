# MinIO client built from the archived upstream source; see docker/minio/Dockerfile
# for why. Alpine keeps /bin/sh, which compose's minio-setup entrypoint needs.
ARG MC_RELEASE=RELEASE.2025-08-13T08-35-41Z

FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS build
ARG MC_RELEASE
ARG TARGETOS
ARG TARGETARCH
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MC_RELEASE}" https://github.com/minio/mc.git /src
WORKDIR /src
RUN LDFLAGS="$(MC_RELEASE=RELEASE go run buildscripts/gen-ldflags.go)" \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -tags kqueue -trimpath -ldflags "$LDFLAGS" -o /out/mc

FROM alpine:3.22
ARG MC_RELEASE
RUN apk add --no-cache ca-certificates
COPY --from=build /out/mc /usr/bin/mc
LABEL org.opencontainers.image.source="https://github.com/tashfeenahmed/circlechat" \
      org.opencontainers.image.description="MinIO client ${MC_RELEASE} built from archived upstream source" \
      org.opencontainers.image.version="${MC_RELEASE}" \
      org.opencontainers.image.licenses="AGPL-3.0"
ENTRYPOINT ["mc"]
