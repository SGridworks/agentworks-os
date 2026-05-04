# syntax=docker/dockerfile:1
ARG TARGETARCH
FROM python:3.11-slim${TARGETARCH:+-${TARGETARCH}} AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml src/ /app/
RUN pip install --user -e .

FROM python:3.11-slim${TARGETARCH:+-${TARGETARCH}}

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    libffi7 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8001/health').raise_for_status()"

ENTRYPOINT ["python", "-m", "scanner_worker.main"]
