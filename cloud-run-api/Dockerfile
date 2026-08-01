FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production
ENV PORT=8080
USER node
CMD ["node", "src/index.js"]
