FROM node:20-bookworm

WORKDIR /app

# Zależności systemowe potrzebne przez Puppeteer (uruchamia prawdziwą
# przeglądarkę Chromium w tle, m.in. do weryfikacji cen konkurencji) - bez
# tego pobrana przeglądarka nie odpali się w minimalnym obrazie Linuksa.
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Instalujemy zależności PRZED skopiowaniem reszty kodu - Docker cache'uje
# ten krok, więc kolejne wdrożenia (gdy zmienia się tylko kod, nie
# package.json) są dużo szybsze.
COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]