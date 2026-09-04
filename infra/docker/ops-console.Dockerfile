FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS validate
WORKDIR /app
ARG OPS_CONSOLE_BUILD_MODE=production
ARG VITE_API_BASE
ARG VITE_BASE=/
RUN set -eu; \
    api_base="${VITE_API_BASE:-}"; \
    test -n "$api_base" || { echo >&2 "VITE_API_BASE is required"; exit 1; }; \
    case "$api_base" in *'?'*|*'#'*|*'@'*) echo >&2 "VITE_API_BASE must not contain query, fragment, or credentials"; exit 1;; esac; \
    case "$OPS_CONSOLE_BUILD_MODE" in \
      production) \
        case "$api_base" in https://*|/api) ;; *) echo >&2 "production VITE_API_BASE must be HTTPS or /api"; exit 1;; esac \
        ;; \
      local) \
        case "$api_base" in http://localhost:*|http://127.0.0.1:*|https://*|/api) ;; *) echo >&2 "local VITE_API_BASE must be loopback HTTP, HTTPS, or /api"; exit 1;; esac \
        ;; \
      *) echo >&2 "OPS_CONSOLE_BUILD_MODE must be production or local"; exit 1;; \
    esac

FROM validate AS build
COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.json
COPY apps/ops-console/package.json apps/ops-console/package.json
RUN npm ci --workspace apps/ops-console --include-workspace-root
COPY packages/contracts packages/contracts
COPY apps/ops-console apps/ops-console
RUN if [ "$OPS_CONSOLE_BUILD_MODE" = production ]; then auth_mode=oidc; else auth_mode=local; fi; \
    VITE_API_BASE="$VITE_API_BASE" VITE_BASE="$VITE_BASE" VITE_OPS_AUTH_MODE="$auth_mode" VITE_OPS_BUILD_MODE="$OPS_CONSOLE_BUILD_MODE" npm run build --workspace apps/ops-console

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:e7623c006de0ea4716e763083668edd9b732371d5479653c2e709fd0696b0348
ENV OPS_API_UPSTREAM=http://127.0.0.1:8787
ENV OPS_API_RESOLVER=127.0.0.11
COPY infra/nginx/ops-console.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/ops-console/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
