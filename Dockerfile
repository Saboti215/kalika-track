# --- Build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite inlines these at build time, so they must be passed as build args.
# Both values are public (the anon key is protected by RLS), so baking them into the image is fine.
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG ENABLE_SIGNUP=true
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    ENABLE_SIGNUP=$ENABLE_SIGNUP

RUN npm run build

# --- Runtime stage -----------------------------------------------------------
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
