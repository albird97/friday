FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY tsconfig.json ./
ENV DATA_DIR=/data NODE_ENV=production
VOLUME /data
CMD ["npm", "start"]
