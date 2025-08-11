FROM node:20-alpine AS builder

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

FROM node:20-alpine AS production

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=builder /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
  adduser -S aggregator -u 1001

RUN chown -R aggregator:nodejs /app

USER aggregator

CMD ["pnpm", "start"]
