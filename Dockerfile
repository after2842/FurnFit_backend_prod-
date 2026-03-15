# --- Build stage ---
FROM node:21-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Production stage ---
FROM node:21-slim AS runner

WORKDIR /app

# Install only production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built output from builder
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/main.js"]
