# syntax=docker/dockerfile:1

FROM node:22-alpine AS base
WORKDIR /app


# --- deps: cached separately from source ---
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci


# --- development: Astro dev server with HMR, source mounted over this layer ---
FROM base AS development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 4321
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]


# --- build: produce the static site ---
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build


# --- production: nginx serving static files, nothing else ---
FROM nginx:1.29-alpine AS production
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1
