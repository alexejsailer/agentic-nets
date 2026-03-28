FROM node:22-alpine

# AgenticOS tool labels (OCI standard + AgenticOS extensions)
LABEL org.opencontainers.image.title="Web Search Tool"
LABEL org.opencontainers.image.description="Searches the web via DuckDuckGo HTML scraping. No API key required."
LABEL org.opencontainers.image.version="1.0.0"
LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="search,web,discover"

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
