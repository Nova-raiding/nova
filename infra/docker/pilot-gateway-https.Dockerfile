FROM docker.m.daocloud.io/nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
COPY infra/nginx/pilot-gateway-https.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080 8443
# The first TLS virtual host is the isolated alert origin and intentionally
# returns 404 for /healthz. Probe the primary application virtual host
# explicitly so adding the alert host cannot make a healthy gateway unhealthy.
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget --no-check-certificate --header='Host: yxsona.com' -qO- https://127.0.0.1:8443/healthz >/dev/null || exit 1
