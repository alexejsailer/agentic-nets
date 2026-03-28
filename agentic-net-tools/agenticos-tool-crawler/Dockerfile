FROM node:22-alpine

# AgetnticOS tool labels (OCI standard + AgetnticOS extensions)
LABEL org.opencontainers.image.title="Web Crawler Tool"
LABEL org.opencontainers.image.description="Crawls web pages and returns structured content. Supports CSS selectors."
LABEL org.opencontainers.image.version="1.0.0"
LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="crawl,scrape,extract,http"

WORKDIR /app
COPY package.json .
RUN npm install --production
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
