FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
COPY shared/package.json ./shared/
COPY services/eval-worker/package.json ./services/eval-worker/
RUN npm install --workspaces
COPY tsconfig.base.json ./
COPY shared/ ./shared/
COPY services/eval-worker/ ./services/eval-worker/
RUN npm run build -w @sentinelai/shared
RUN npm run build -w @sentinelai/eval-worker

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/services/eval-worker/dist ./dist
COPY --from=builder /app/shared ./shared
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
