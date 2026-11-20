FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git libstdc++6 python3 bubblewrap socat poppler-utils \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --uid 10001 --create-home --shell /bin/bash chimeric \
    && mkdir -p /state /opt/chimeric \
    && chown -R chimeric:chimeric /state /opt/chimeric

COPY --chown=chimeric:chimeric dist/portable/ /opt/chimeric/

ENV BUN_BE_BUN=1 \
    SCIENCE_LOCAL_PROFILE=/state \
    CHIMERIC_DATA_DIR=/state \
    PATH="/opt/chimeric:/opt/chimeric/bin:${PATH}"

USER chimeric
WORKDIR /opt/chimeric
VOLUME ["/state"]
EXPOSE 18868 18869

ENTRYPOINT ["/opt/chimeric/chimeric"]
CMD ["serve", "--profile", "/state", "--port", "18868"]
