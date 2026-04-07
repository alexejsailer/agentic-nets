FROM node:22-alpine

LABEL org.opencontainers.image.title="Secured API Tool"
LABEL org.opencontainers.image.description="Test API endpoint requiring X-API-Key authentication. Validates credentials and returns secured data."
LABEL org.opencontainers.image.version="1.0.0"

LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="auth,api-key,secured-endpoint"

WORKDIR /app
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
