FROM node:22-alpine

# Release version injected by build scripts (--build-arg VERSION=x.y.z)
ARG VERSION=1.0.0

# AgenticOS tool labels (OCI standard + AgenticOS extensions)
LABEL org.opencontainers.image.title="Weather Tool"
LABEL org.opencontainers.image.description="Deterministic mock current-weather REST API for a city. Demo tool for the AgenticOS Docker tool registry."
LABEL org.opencontainers.image.version="${VERSION}"
LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="weather,forecast,demo"

WORKDIR /app
COPY server.js .

# Run unprivileged: node:alpine ships the 'node' user (uid 1000); port 8080 needs no root.
RUN chown -R node:node /app
USER node

EXPOSE 8080
CMD ["node", "server.js"]
