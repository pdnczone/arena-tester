FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*

# Proxy clients used by the VPN test. If GitHub is blocked on your server, build with
#   --build-arg XRAY_URL=<mirror url of the matching Xray zip>
ARG TARGETARCH
ARG XRAY_URL=
RUN set -eux; \
  arch="${TARGETARCH:-amd64}"; \
  case "$arch" in amd64|x86_64) zip=Xray-linux-64.zip ;; arm64|aarch64) zip=Xray-linux-arm64-v8a.zip ;; *) zip=Xray-linux-64.zip ;; esac; \
  url="${XRAY_URL:-https://github.com/XTLS/Xray-core/releases/latest/download/$zip}"; \
  curl -fsSL "$url" -o /tmp/xray.zip && unzip -o /tmp/xray.zip xray -d /usr/local/bin && chmod +x /usr/local/bin/xray && rm /tmp/xray.zip

# Optional: sing-box (needed only for hysteria2 / tuic links). Uncomment and set a URL.
# ARG SINGBOX_URL=
# RUN curl -fsSL "$SINGBOX_URL" | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/sing-box'

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080
EXPOSE 8080 8081
CMD ["node", "server.js"]
