FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tests ./tests
COPY demo ./demo
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts ./
COPY infra/scripts/generate-container-source-manifest.mjs ./infra/scripts/generate-container-source-manifest.mjs
RUN node infra/scripts/generate-container-source-manifest.mjs generate api /app \
  /app/.release-source/api.manifest /app/.release-source/api.manifest.sha256 \
  && node infra/scripts/generate-container-source-manifest.mjs generate worker /app \
  /app/.release-source/worker.manifest /app/.release-source/worker.manifest.sha256
RUN --mount=type=cache,id=merchant-npm-cache,target=/root/.npm,sharing=locked \
  npm ci --prefer-offline --no-audit --fund=false
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -g 10001 -S merchant && adduser -u 10001 -S -D -H -G merchant merchant
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=merchant-npm-cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev --prefer-offline --no-audit --fund=false
COPY --from=build /app/dist ./dist
# Keep the release migration inventory at the same stable path as the API
# image so the freshness gate can inspect both images without starting them.
COPY packages/persistence/src/migrations ./dist/packages/persistence/src/migrations
COPY --from=build /app/packages ./packages
RUN mkdir -p node_modules/@merchant-marketing \
  && for package_dir in packages/*; do \
       package_name="$(node -p "require('./$package_dir/package.json').name" 2>/dev/null || true)"; \
       case "$package_name" in \
         @merchant-marketing/*) ln -sfn "../../$package_dir" "node_modules/$package_name" ;; \
       esac; \
     done
COPY --from=build /app/.release-source/worker.manifest /app/.release-source/worker.manifest
COPY --from=build /app/.release-source/worker.manifest.sha256 /app/.release-source/worker.manifest.sha256
USER 10001:10001
CMD ["node", "dist/apps/worker/src/main.js"]
