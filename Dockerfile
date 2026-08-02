# apple-podcasts-mcp — stdio MCP server for Apple Podcasts Connect owner analytics
# Build:  docker build -t apple-podcasts-mcp .
# Run:    docker run -i --rm \
#           -e APPLE_PODCASTS_ACCESS_TOKEN=... \
#           -e APPLE_PODCASTS_VENDOR_ID=... \
#           apple-podcasts-mcp

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

# Credentials come from the environment and are never baked into the image.
# The server starts without them so a client can list its tools; each tool call
# then fails with a message naming the variable that is missing. That is what
# lets an introspection-only check pass with no Apple account attached.
ENTRYPOINT ["node", "dist/index.js"]
