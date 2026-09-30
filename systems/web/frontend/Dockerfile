FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Backend ports the browser talks to directly (CORS-enabled), same pattern as the
# other frontends. The host is taken from the page at runtime, see src/config.ts.
ARG VITE_EXECUTION_PORT=8002
ARG VITE_MARKET_DATA_PORT=8001
ARG VITE_ACCOUNTS_PORT=8004
ARG VITE_SIGNAL_ENGINE_PORT=8000
ARG VITE_SHELL_PORT=8090
ENV VITE_EXECUTION_PORT=$VITE_EXECUTION_PORT
ENV VITE_MARKET_DATA_PORT=$VITE_MARKET_DATA_PORT
ENV VITE_ACCOUNTS_PORT=$VITE_ACCOUNTS_PORT
ENV VITE_SIGNAL_ENGINE_PORT=$VITE_SIGNAL_ENGINE_PORT
ENV VITE_SHELL_PORT=$VITE_SHELL_PORT
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
