FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/alert-receiver ./apps/alert-receiver
COPY packages ./packages
RUN --mount=type=cache,id=merchant-npm-cache,target=/root/.npm,sharing=locked \
  npm ci --prefer-offline --no-audit --fund=false
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production ALERT_RECEIVER_PORT=8791 ALERT_RECEIVER_BIND_HOST=0.0.0.0
WORKDIR /app
RUN addgroup -g 10001 -S merchant && adduser -u 10001 -S -D -H -G merchant merchant
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=merchant-npm-cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev --prefer-offline --no-audit --fund=false
COPY --from=build /app/dist/apps/alert-receiver ./dist/apps/alert-receiver
USER 10001:10001
EXPOSE 8791
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8791/readyz >/dev/null || exit 1
CMD ["node", "dist/apps/alert-receiver/src/server.js"]
