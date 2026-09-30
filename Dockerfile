# GetFlop has no dependencies to install: the image is Node plus the source.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4000 DB_FILE=/app/data/getflop.db
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4000/v1/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/main.ts"]
