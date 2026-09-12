FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
COPY demo/merchant-studio/package.json demo/merchant-studio/package-lock.json ./
RUN npm ci
COPY demo/merchant-studio ./
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ARG VITE_WORKSPACE_ID
ENV VITE_WORKSPACE_ID=$VITE_WORKSPACE_ID
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
COPY infra/nginx/merchant-studio.conf /etc/nginx/merchant-studio.conf.template
COPY --chmod=0755 infra/nginx/merchant-studio-entrypoint.sh /docker-entrypoint.d/40-merchant-studio-token.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/ || exit 1
