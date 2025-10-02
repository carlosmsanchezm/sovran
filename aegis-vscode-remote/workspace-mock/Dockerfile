FROM debian:bookworm-slim

ARG VSCODE_COMMIT=80e42490bbf07d83fe573204416be3949ef27bd1
ARG VSCODE_QUALITY=insider

RUN apt-get update \
  && apt-get install -y curl ca-certificates jq bash tini \
  && rm -rf /var/lib/apt/lists/*

ENV HOME=/root \
    VSCODE_COMMIT=${VSCODE_COMMIT} \
    VSCODE_QUALITY=${VSCODE_QUALITY}

WORKDIR /root

COPY start-reh.sh /usr/local/bin/start-reh.sh
RUN chmod +x /usr/local/bin/start-reh.sh

EXPOSE 11111

ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/usr/local/bin/start-reh.sh"]
