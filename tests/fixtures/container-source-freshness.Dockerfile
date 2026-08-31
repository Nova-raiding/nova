FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS source
WORKDIR /workspace
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY infra/scripts/generate-container-source-manifest.mjs ./infra/scripts/generate-container-source-manifest.mjs

FROM source AS api-manifest
RUN node infra/scripts/generate-container-source-manifest.mjs generate api /workspace \
  /workspace/.release-source/api.manifest /workspace/.release-source/api.manifest.sha256

FROM scratch AS api-source-attestation-fixture
COPY --from=api-manifest /workspace/.release-source/api.manifest /app/.release-source/api.manifest
COPY --from=api-manifest /workspace/.release-source/api.manifest.sha256 /app/.release-source/api.manifest.sha256
COPY packages/persistence/src/migrations /app/dist/packages/persistence/src/migrations
CMD ["/fixture-not-runnable"]

FROM api-manifest AS api-tampered-manifest
RUN node -e "const fs=require('node:fs');const crypto=require('node:crypto');const path='/workspace/.release-source/api.manifest';const lines=fs.readFileSync(path,'utf8').split('\\n');lines[0]='0'.repeat(64)+lines[0].slice(64);const bytes=lines.join('\\n');fs.writeFileSync(path,bytes);fs.writeFileSync(path+'.sha256','sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')+'\\n')"

FROM scratch AS api-tampered-source-attestation-fixture
COPY --from=api-tampered-manifest /workspace/.release-source/api.manifest /app/.release-source/api.manifest
COPY --from=api-tampered-manifest /workspace/.release-source/api.manifest.sha256 /app/.release-source/api.manifest.sha256
COPY packages/persistence/src/migrations /app/dist/packages/persistence/src/migrations
CMD ["/fixture-not-runnable"]

FROM source AS worker-manifest
RUN node infra/scripts/generate-container-source-manifest.mjs generate worker /workspace \
  /workspace/.release-source/worker.manifest /workspace/.release-source/worker.manifest.sha256

FROM scratch AS worker-source-attestation-fixture
COPY --from=worker-manifest /workspace/.release-source/worker.manifest /app/.release-source/worker.manifest
COPY --from=worker-manifest /workspace/.release-source/worker.manifest.sha256 /app/.release-source/worker.manifest.sha256
COPY packages/persistence/src/migrations /app/dist/packages/persistence/src/migrations
CMD ["/fixture-not-runnable"]

FROM scratch AS combined-source-attestation-fixture
COPY --from=api-manifest /workspace/.release-source/api.manifest /app/.release-source/api.manifest
COPY --from=api-manifest /workspace/.release-source/api.manifest.sha256 /app/.release-source/api.manifest.sha256
COPY --from=worker-manifest /workspace/.release-source/worker.manifest /app/.release-source/worker.manifest
COPY --from=worker-manifest /workspace/.release-source/worker.manifest.sha256 /app/.release-source/worker.manifest.sha256
COPY packages/persistence/src/migrations /app/dist/packages/persistence/src/migrations
CMD ["/fixture-not-runnable"]
