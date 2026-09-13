FROM node:22-alpine

WORKDIR /app

# 의존성을 먼저 설치해 레이어 캐시를 살린다
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=9376
EXPOSE 9376

CMD ["node", "src/server.js"]
