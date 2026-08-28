FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG VITE_API_BASE_URL=/api
ARG VITE_SIGNAL_ENGINE_PORT=8000
ARG VITE_ACCOUNTS_PORT=8004
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_SIGNAL_ENGINE_PORT=$VITE_SIGNAL_ENGINE_PORT
ENV VITE_ACCOUNTS_PORT=$VITE_ACCOUNTS_PORT
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
