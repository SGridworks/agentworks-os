# syntax=docker/dockerfile:1
#
# AgentWorks OS — Installer Docker Image
#
# This image bundles the install.sh bootstrap script and a minimal runtime
# so the installer can be run as:
#   docker run --rm -it \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     agentworks/installer:latest
#
# It is also the source of the curl | bash installer at:
#   curl -fsSL https://get.agentworks.os/install.sh | bash
#
FROM debian:bookworm-slim AS builder

ARG TARGETARCH
WORKDIR /src

# Pre-download docker-compose binary so the final image stays small
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install docker-compose standalone (v2)
RUN curl -fsSL \
    "https://github.com/docker/compose/releases/download/v2.24.0/docker-compose-linux-${TARGETARCH:-amd64}" \
    -o /usr/local/bin/docker-compose \
    && chmod +x /usr/local/bin/docker-compose

# ---------------------------------------------------------------------------
FROM debian:bookworm-slim

ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    openssl \
    python3 \
    docker-compose \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

WORKDIR /install

COPY --from=builder /usr/local/bin/docker-compose /usr/local/bin/docker-compose

COPY bin/install.sh .

RUN chmod +x install.sh

# The entrypoint wrapper handles the docker.sock mount check and passes
# through any arguments (--unattended, --dry-run, etc.)
ENTRYPOINT ["/install/install.sh"]
