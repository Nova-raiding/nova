FROM nginxinc/nginx-unprivileged:1.27-alpine@sha256:e7623c006de0ea4716e763083668edd9b732371d5479653c2e709fd0696b0348
COPY infra/nginx/pilot-gateway.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null
