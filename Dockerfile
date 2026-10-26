FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY worker.js ./
COPY db ./db
COPY public ./public

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.js"]
