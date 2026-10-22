FROM node:22-bookworm-slim
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=128
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node . .
USER node
EXPOSE 3000
CMD ["npm","start"]
