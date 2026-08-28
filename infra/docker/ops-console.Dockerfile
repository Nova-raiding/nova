FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/ops-console/package.json apps/ops-console/package.json
RUN npm ci --workspace apps/ops-console --include-workspace-root
COPY apps/ops-console apps/ops-console
ARG VITE_API_BASE=
ARG VITE_OPS_AUTH_MODE=oidc
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_OPS_AUTH_MODE=$VITE_OPS_AUTH_MODE
RUN npm run build --workspace apps/ops-console

FROM nginx:1.27-alpine
COPY infra/nginx/ops-console.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/ops-console/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/ || exit 1
