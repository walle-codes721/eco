# Runs Eco locally in mock mode (no API key needed): docker build -t eco . && docker run -p 8787:8787 eco
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
EXPOSE 8787
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787"]
