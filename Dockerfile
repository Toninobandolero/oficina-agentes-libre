FROM node:22-alpine
RUN apk add --no-cache tzdata ffmpeg
ENV NODE_ENV=production TZ=Europe/Madrid
WORKDIR /app
COPY --chown=node:node servidor/package.json servidor/package-lock.json ./servidor/
RUN cd servidor && npm ci --omit=dev
COPY --chown=node:node servidor/src ./servidor/src
COPY --chown=node:node skills ./skills
COPY --chown=node:node panel ./panel
RUN chmod -R a+rX /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/salud || exit 1
CMD ["node", "servidor/src/index.js"]
