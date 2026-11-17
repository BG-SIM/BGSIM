# BGSIM relay — 极简、可单独部署的联机中继
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8790 \
    HOST=0.0.0.0

WORKDIR /app

# 只有 ws 一个依赖；先复制清单再装，改 relay.mjs 不会让这一层失效
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY relay.mjs ./

# 中继不写盘、不读盘，跑成非 root 更安全
USER node

EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay.mjs"]
