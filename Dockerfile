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
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# WYMUSZAMY zbudowanie sqlite3 OD ZERA na tym konkretnym systemie, zamiast
# pobierania gotowego, wcześniej skompilowanego pliku - ten gotowy plik był
# zbudowany dla nowszej wersji glibc niż ma ten obraz (stąd błąd
# "GLIBC_2.38 not found"). Budowanie od zera wymaga python3/make/g++
# (zainstalowane wyżej) - z tym gwarantujemy dopasowanie do TEGO systemu.
ENV npm_config_build_from_source=true

# Instalujemy zależności PRZED skopiowaniem reszty kodu - Docker cache'uje
# ten krok, więc kolejne wdrożenia (gdy zmienia się tylko kod, nie
# package.json) są dużo szybsze.
COPY package.json package-lock.json ./
RUN npm install

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]