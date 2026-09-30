FROM node:24-alpine AS builder

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src

RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24-alpine AS production

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
  adduser -S aggregator -u 1001 -G nodejs && \
  mkdir -p /app/checkpoints && \
  chown -R aggregator:nodejs /app/checkpoints

USER aggregator

ENV CHECKPOINT_DIR=/app/checkpoints
VOLUME ["/app/checkpoints"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# node itself is the first process, so SIGTERM from docker stop reaches the drain.
CMD ["node", "dist/index.js"]
