FROM node:22-alpine

# Release version injected by build scripts (--build-arg VERSION=x.y.z)
ARG VERSION=1.0.0

LABEL org.opencontainers.image.title="Secured API Tool"
LABEL org.opencontainers.image.description="Test API endpoint requiring X-API-Key authentication. Validates credentials and returns secured data."
LABEL org.opencontainers.image.version="${VERSION}"

LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="auth,api-key,secured-endpoint"

WORKDIR /app
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
