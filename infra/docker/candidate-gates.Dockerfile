FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG CANDIDATE_GIT_SHA
ARG CANDIDATE_SOURCE_SHA256
LABEL org.opencontainers.image.revision=$CANDIDATE_GIT_SHA \
      com.storenova.candidate.source_sha256=$CANDIDATE_SOURCE_SHA256
WORKDIR /workspace
COPY . .
RUN npm ci --no-audit --fund=false \
    && chown -R 65534:65534 /workspace
USER 65534:65534
CMD ["sh", "-c", "npm run typecheck && npm run test:release-gates"]
