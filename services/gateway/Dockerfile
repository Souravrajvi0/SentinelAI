FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY shared/package.json ./shared/
COPY services/gateway/package.json ./services/gateway/
RUN npm install --workspaces
COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/gateway/ ./services/gateway/
RUN npm run build -w @sentinelai/shared
RUN npm run build -w @sentinelai/gateway

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/services/gateway/dist ./dist
COPY --from=builder /app/shared ./shared
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
