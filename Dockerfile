# NexusPanel
#
# Blitzschnell bei Updates:
# - Backend (dist/) und Frontend (web/dist/) werden bereits lokal von deploy.ps1
#   in ~1.5 s gebaut und direkt ins Image kopiert (kein doppelter tsc/vite-Lauf auf der VM).
# - Die Versionsnummer in package.json wird in der Stufe "manifest" auf 0.0.0
#   normiert UND der Datei-Zeitstempel (mtime) fest auf 0 gesetzt. Dadurch bleibt
#   "npm ci --omit=dev" zu 100 % im Docker-Cache, solange sich keine Pakete aendern.

# 0) package*.json ohne Versionsnummer und mit festem Zeitstempel (fuer 100% Cache-Hit)
FROM node:22-alpine AS manifest
WORKDIR /m
COPY package.json package-lock.json ./
RUN node -e "const fs=require('fs');for(const f of ['package.json','package-lock.json']){const j=JSON.parse(fs.readFileSync(f,'utf8'));j.version='0.0.0';if(j.packages&&j.packages['']){j.packages[''].version='0.0.0';}fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n');fs.utimesSync(f,0,0);}"

# 1) Laufzeit-Abhaengigkeiten (nur Produktion) - bleibt gecacht, solange Pakete gleich bleiben
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY --from=manifest /m/package.json /m/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# 2) Fertiges Laufzeit-Image
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tzdata tini tar zstd
COPY --from=prod-deps /app/node_modules ./node_modules
# Echte package.json (mit Versionsnummer) - src/version.ts liest sie zur Laufzeit
COPY package*.json ./
COPY dist ./dist
COPY web/dist ./web/dist
COPY migrations ./migrations
# Mitgelieferte Spiele - werden beim Start eingespielt, sofern noch nicht vorhanden
COPY eggs ./eggs
# Dokumentation & Version ("Was ist neu", Konzepte, Architektur, Devlog)
COPY docs ./docs
COPY *.md build-info.jso[n] ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(0)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
