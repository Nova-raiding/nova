FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests ./tests
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts ./
RUN npm ci
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app
RUN addgroup -S merchant && adduser -S merchant -G merchant
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# TypeScript does not emit SQL assets; the migration loader resolves this
# path relative to the compiled module at runtime.
COPY packages/persistence/src/migrations ./dist/packages/persistence/src/migrations
COPY --from=build /app/apps/plugin ./apps/plugin
COPY --from=build /app/packages ./packages
USER merchant
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "dist/apps/api/src/server.js"]
