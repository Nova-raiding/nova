FROM node:22-alpine AS build
WORKDIR /app
COPY demo/merchant-studio/package.json demo/merchant-studio/package-lock.json ./
RUN npm ci
COPY demo/merchant-studio ./
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN npm run build

FROM nginx:1.27-alpine
COPY infra/nginx/merchant-studio.conf /etc/nginx/merchant-studio.conf.template
COPY infra/nginx/merchant-studio-entrypoint.sh /docker-entrypoint.d/40-merchant-studio-token.sh
RUN chmod 0755 /docker-entrypoint.d/40-merchant-studio-token.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1/ || exit 1
