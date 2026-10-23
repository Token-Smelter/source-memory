# Source Memory CLI. Run with docker compose to get a matching Neo4j server,
# or mount your own config that points at an existing Neo4j 5.26+ server.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY config ./config
COPY skills ./skills
COPY LICENSE README.md ./

USER node
ENV SOURCE_MEMORY_CONFIG=/app/config/docker.json
ENTRYPOINT ["node", "/app/bin/memory.mjs"]
