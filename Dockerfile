# NexusPanel
#
# Schnell bei Updates:
# - Die Versionsnummer in package.json aendert sich bei jedem Update. Damit
#   "npm ci" trotzdem aus dem Cache kommt, bekommen die Installationsschritte
#   eine Kopie der package*.json mit fester Version 0.0.0 (Stufe "manifest").
#   Neu installiert wird nur, wenn sich wirklich Abhaengigkeiten aendern.
# - npm-Downloads landen in einem BuildKit-Cache und werden wiederverwendet.

# 0) package*.json ohne Versionsnummer (fuer den Cache)
FROM node:22-alpine AS manifest
WORKDIR /m
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/
RUN node -e "const fs=require('fs');for(const f of ['package.json','package-lock.json','web/package.json','web/package-lock.json']){const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='0.0.0';if(j.packages&&j.packages['']){j.packages[''].version='0.0.0';}fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');}"

# 1) Weboberflaeche bauen
FROM node:22-alpine AS web
WORKDIR /web
COPY --from=manifest /m/web/package.json /m/web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2) Backend bauen
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=manifest /m/package.json /m/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 3) Laufzeit-Abhaengigkeiten (nur Produktion) - eigene Stufe, damit sie
#    gecacht bleibt, solange sich die Abhaengigkeiten nicht aendern
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY --from=manifest /m/package.json /m/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tzdata tini tar zstd
COPY --from=prod-deps /app/node_modules ./node_modules
# Echte package.json (mit Versionsnummer) - src/version.ts liest sie zur Laufzeit
COPY package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./web/dist
COPY migrations ./migrations
# Mitgelieferte Spiele - werden beim Start eingespielt, sofern noch nicht vorhanden
COPY eggs ./eggs
# Dokumentation & Version ("Was ist neu", Konzepte, Architektur, Devlog)
COPY docs ./docs
COPY *.md build-info.jso[n] ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
