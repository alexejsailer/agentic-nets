FROM node:22-alpine

# Release version injected by build scripts (--build-arg VERSION=x.y.z)
ARG VERSION=1.0.0

# AgenticOS tool labels (OCI standard + AgenticOS extensions)
LABEL org.opencontainers.image.title="Reddit Tool"
LABEL org.opencontainers.image.description="Fetches posts, comments, and search results from Reddit's JSON API"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="reddit,posts,comments,search,community"

WORKDIR /app
RUN apk add --no-cache ca-certificates && update-ca-certificates
# No npm install: server.js uses only node built-ins (http + global fetch)
COPY package.json .
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
