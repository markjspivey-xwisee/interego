FROM node:22-slim
WORKDIR /app
COPY applications/health-bridge/package.json applications/health-bridge/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY applications/health-bridge/ ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
