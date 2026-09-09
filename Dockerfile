# traffic-chimes: headless Chromium renders https://the-101-plays-itself.netlify.app/
# and its Web Audio output is re-encoded to a live MP3 stream.
FROM node:22-bookworm-slim

# Debian's chromium ships with proprietary codecs, so the Caltrans H.264 HLS
# feed decodes. tini (-s: works even when not PID 1) reaps Chromium helpers. curl is for HEALTHCHECK.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium ffmpeg tini curl ca-certificates fonts-liberation \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    CHROME_PATH=/usr/bin/chromium \
    HOME=/home/node \
    PORT=8000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts

USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:8000/health > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "src/index.js"]
