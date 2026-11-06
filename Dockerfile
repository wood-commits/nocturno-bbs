# Nocturno BBS container image. No runtime packages: only the source and sample art.
# Build:  docker build -t nocturno-bbs .
# Pin a digest (node:24-slim@sha256:...) for reproducible production builds.
FROM node:24-slim

ENV NODE_ENV=production \
    BBS_DATA_DIR=/data \
    BBS_TLS_HOST=0.0.0.0 \
    BBS_DASHBOARD=0

WORKDIR /app
# Root-owned, read-only application files; only /data and the console socket
# directory belong to the unprivileged runtime user.
COPY package.json LICENSE ./
COPY src ./src
COPY examples ./examples
# Build contexts from Windows checkouts arrive as 0777; normalize so the runtime user
# can read but never rewrite application code.
RUN find /app -type d -exec chmod 0755 {} + \
 && find /app -type f -exec chmod 0644 {} + \
 && mkdir -p /data /run/nocturno \
 && chown node:node /data /run/nocturno \
 && chmod 0700 /data /run/nocturno

USER node
VOLUME ["/data"]
# TLS only. Plaintext telnet (2323) stays bound to loopback inside the container.
EXPOSE 9923
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
