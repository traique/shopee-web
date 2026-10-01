FROM node:22-trixie-slim

ENV NODE_ENV=production \
    HOME=/tmp

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src

USER node

EXPOSE 10000

CMD ["node", "src/server.js"]
