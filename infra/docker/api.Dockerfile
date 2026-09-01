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
ENV PORT=8787
WORKDIR /app
RUN addgroup -g 10001 -S merchant && adduser -u 10001 -S -D -H -G merchant merchant \
  && mkdir -p /var/lib/merchant-assets \
  && chown 10001:10001 /var/lib/merchant-assets
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=merchant-npm-cache,target=/root/.npm,sharing=locked \
  npm ci --omit=dev --prefer-offline --no-audit --fund=false
COPY --from=build /app/dist ./dist
# TypeScript does not emit SQL assets; the migration loader resolves this
# path relative to the compiled module at runtime.
COPY packages/persistence/src/migrations ./dist/packages/persistence/src/migrations
COPY --from=build /app/apps/plugin ./apps/plugin
COPY --from=build /app/packages ./packages
# The runtime install happens before workspace sources are copied, so npm
# cannot create links for private @merchant-marketing packages. Compiled code
# may legitimately import their public exports; wire those package roots after
# the build artifacts are present.
RUN mkdir -p node_modules/@merchant-marketing \
  && for package_dir in packages/*; do \
       package_name="$(node -p "require('./$package_dir/package.json').name" 2>/dev/null || true)"; \
       case "$package_name" in \
         @merchant-marketing/*) ln -sfn "../../$package_dir" "node_modules/$package_name" ;; \
       esac; \
     done
COPY --from=build /app/.release-source/api.manifest /app/.release-source/api.manifest
COPY --from=build /app/.release-source/api.manifest.sha256 /app/.release-source/api.manifest.sha256
USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8787/readyz || exit 1
CMD ["node", "dist/apps/api/src/server.js"]
