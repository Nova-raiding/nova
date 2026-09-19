FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY services ./services
COPY tests ./tests
COPY demo ./demo
COPY scripts ./scripts
# Release-gate tests imported by the root composite build use the checked-in
# attestation helpers. Keep them in the build stage only; they are not copied
# into the runtime image.
COPY infra/protected ./infra/protected
COPY tsconfig.json vitest*.config.ts ./
COPY infra/scripts/generate-container-source-manifest.mjs ./infra/scripts/generate-container-source-manifest.mjs
# Host-side incremental state must never control which checked-in source is
# emitted into the runtime image. A stale tsbuildinfo can otherwise make the
# API container run an older compiled module after a source change.
RUN find /app -name '*.tsbuildinfo' -type f -delete
RUN node infra/scripts/generate-container-source-manifest.mjs generate api /app \
  /app/.release-source/api.manifest /app/.release-source/api.manifest.sha256 \
  && node infra/scripts/generate-container-source-manifest.mjs generate worker /app \
  /app/.release-source/worker.manifest /app/.release-source/worker.manifest.sha256
RUN --mount=type=cache,id=merchant-npm-cache,target=/root/.npm npm ci --prefer-offline --no-audit --fund=false
# Build the published workspace declarations before the root composite build.
# The application package resolves contracts through its package export and
# therefore requires contracts/dist/*.d.ts to exist inside the image.
RUN npm run build --workspace @merchant-marketing/contracts
RUN npm run build

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production
ENV PORT=8787
WORKDIR /app
RUN apk add --no-cache postgresql16-client \
  && addgroup -g 10001 -S merchant && adduser -u 10001 -S -D -H -G merchant merchant \
  && mkdir -p /var/lib/merchant-assets \
  && chown 10001:10001 /var/lib/merchant-assets
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --prefer-offline --no-audit --fund=false
COPY --from=build /app/dist ./dist
# TypeScript does not emit SQL assets; the migration loader resolves this
# path relative to the compiled module at runtime.
COPY packages/persistence/src/migrations ./dist/packages/persistence/src/migrations
COPY --from=build /app/apps/plugin ./apps/plugin
COPY --from=build /app/packages ./packages
COPY --from=build /app/dist/packages/contracts/src ./packages/contracts/dist
# Billing callback signing is intentionally kept as a checked-in ESM asset
# rather than compiled TypeScript. The compiled payment provider imports it at
# runtime, so the API image must carry the exact source asset alongside the
# generated package output.
COPY packages/billing/src/callback-envelope.mjs ./dist/packages/billing/src/callback-envelope.mjs
COPY packages/billing/src/callback-envelope.d.mts ./dist/packages/billing/src/callback-envelope.d.mts
# The runtime install happens before workspace sources are copied, so npm
# cannot create links for private @merchant-marketing packages. Compiled code
# may legitimately import their public exports; wire those package roots after
# the build artifacts are present.
RUN mkdir -p node_modules/@merchant-marketing \
  && for package_dir in packages/*; do \
       package_name="$(node -p "require('./$package_dir/package.json').name" 2>/dev/null || true)"; \
       case "$package_name" in \
         @merchant-marketing/*) \
           ln -sfn "../../$package_dir" "node_modules/$package_name" ;; \
       esac; \
     done \
  && chmod -R a+rX /app/packages /app/dist
COPY --from=build /app/.release-source/api.manifest /app/.release-source/api.manifest
COPY --from=build /app/.release-source/api.manifest.sha256 /app/.release-source/api.manifest.sha256
USER 10001:10001
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8787/readyz || exit 1
CMD ["node", "dist/apps/api/src/server.js"]
