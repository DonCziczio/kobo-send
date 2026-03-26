FROM node:18-slim

# Install calibre (for ebook-convert: PDF/MOBI/AZW3/FB2 → EPUB)
RUN apt-get update && apt-get install -y --no-install-recommends \
    calibre \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install kepubify (EPUB → Kobo EPUB)
RUN wget -q https://github.com/pgaskin/kepubify/releases/download/v4.0.4/kepubify-linux-64bit \
    -O /usr/local/bin/kepubify \
    && chmod +x /usr/local/bin/kepubify

WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY . .

RUN mkdir -p uploads

EXPOSE 3000
CMD ["node", "server.js"]
