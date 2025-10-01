FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y curl ca-certificates jq bash tini && rm -rf /var/lib/apt/lists/*
ENV HOME=/root
WORKDIR /root
COPY start-reh.sh /usr/local/bin/start-reh.sh
RUN chmod +x /usr/local/bin/start-reh.sh
EXPOSE 11111
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["/usr/local/bin/start-reh.sh"]
