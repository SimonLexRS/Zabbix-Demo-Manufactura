# Planta Aceitera 3D — simulador + cliente Three.js + endpoints para Zabbix.
# Sin dependencias npm: solo Node.js.
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    SIM_SPEED=1

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY js ./js
COPY css ./css
COPY index.html favicon.svg ./

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "server/server.js"]
