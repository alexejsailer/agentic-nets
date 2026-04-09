FROM node:22-alpine

# AgenticOS tool labels (OCI standard + AgenticOS extensions)
LABEL org.opencontainers.image.title="RSS Feed Tool"
LABEL org.opencontainers.image.description="Fetches and parses RSS/Atom feeds. Supports filtering by date and max items."
LABEL org.opencontainers.image.version="1.0.0"
LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="rss,atom,feed,parse"

WORKDIR /app
RUN apk add --no-cache ca-certificates && update-ca-certificates
COPY package.json .
RUN npm install --production
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
