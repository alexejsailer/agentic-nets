FROM node:22-alpine

# AgetnticOS tool labels (OCI standard + AgetnticOS extensions)
LABEL org.opencontainers.image.title="Echo Tool"
LABEL org.opencontainers.image.description="Echoes back request data with metadata. Demo/test tool for the AgetnticOS tool registry."
LABEL org.opencontainers.image.version="1.0.0"
LABEL io.agenticos.tool.kind="api"
LABEL io.agenticos.tool.port="8080"
LABEL io.agenticos.tool.health="/health"
LABEL io.agenticos.tool.openapi="/openapi.json"
LABEL io.agenticos.tool.capabilities="echo,test,debug"

WORKDIR /app
COPY server.js .

EXPOSE 8080
CMD ["node", "server.js"]
