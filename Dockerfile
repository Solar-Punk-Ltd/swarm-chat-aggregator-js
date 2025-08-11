FROM node:20-alpine AS base

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm build

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

COPY --from=base /app/dist ./dist

RUN addgroup -g 1001 -S nodejs && \
  adduser -S aggregator -u 1001

RUN chown -R aggregator:nodejs /app

USER aggregator

EXPOSE 3000

# Start the application
CMD ["pnpm", "start"]
