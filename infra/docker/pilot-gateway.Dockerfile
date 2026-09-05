FROM docker.m.daocloud.io/nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
COPY infra/nginx/pilot-gateway.conf /etc/nginx/templates/default.conf.template
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null
