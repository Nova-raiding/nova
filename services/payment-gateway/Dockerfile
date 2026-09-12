FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS source
WORKDIR /source
# Copy only the files that are part of the gateway release contract.  Do not
# copy the whole service directory into an intermediate layer: an accidentally
# added .env, PEM, or local fixture must never enter the build cache.
COPY services/payment-gateway/Dockerfile ./services/payment-gateway/Dockerfile
COPY services/payment-gateway/index.mjs ./services/payment-gateway/index.mjs
COPY services/payment-gateway/alipay.mjs ./services/payment-gateway/alipay.mjs
COPY services/payment-gateway/alipay.d.mts ./services/payment-gateway/alipay.d.mts
COPY infra/scripts/generate-container-source-manifest.mjs ./infra/scripts/generate-container-source-manifest.mjs
RUN node infra/scripts/generate-container-source-manifest.mjs generate gateway /source \
  /source/.release-source/gateway.manifest /source/.release-source/gateway.manifest.sha256

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
COPY --from=source /source/services/payment-gateway/index.mjs ./index.mjs
COPY --from=source /source/services/payment-gateway/alipay.mjs ./alipay.mjs
COPY --from=source /source/.release-source/gateway.manifest /app/.release-source/gateway.manifest
COPY --from=source /source/.release-source/gateway.manifest.sha256 /app/.release-source/gateway.manifest.sha256
# Keep the runtime identity stable so the host-mounted key files can grant
# read access without making them world-readable.  The rotation script uses
# this same UID/GID contract (100:101).
RUN addgroup -S -g 101 gateway && adduser -S -D -H -u 100 -G gateway gateway
USER gateway
ENV NODE_ENV=production PORT=8790
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8790/healthz >/dev/null
CMD ["node", "index.mjs"]
