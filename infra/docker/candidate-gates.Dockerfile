FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
RUN apk add --no-cache git python3
ARG CANDIDATE_GIT_SHA
ARG CANDIDATE_SOURCE_SHA256
LABEL org.opencontainers.image.revision=$CANDIDATE_GIT_SHA \
      com.storenova.candidate.source_sha256=$CANDIDATE_SOURCE_SHA256
WORKDIR /workspace
COPY . .
# Fail closed if a local runtime secret or generated evidence reached the build
# context. The supported build path (infra/scripts/build-ecs-candidate-gates-image.sh)
# archives committed source only, so this can only trip on a manual
# `docker build .` whose .dockerignore is missing or stale. Note the limit: the
# COPY above already wrote an intermediate layer before this check runs, so treat
# .dockerignore — not this assertion — as the control that keeps secrets out.
RUN test ! -e .env \
    && test ! -e .env.production-config-path \
    && test ! -e .env.production.yaml \
    && test ! -e .codegraph
RUN npm ci --no-audit --fund=false \
    && npm ci --prefix demo/merchant-studio --no-audit --fund=false \
    && chown -R 65534:65534 /workspace
USER 65534:65534
CMD ["sh", "-c", "npm run typecheck && npm run test:release-gates"]
