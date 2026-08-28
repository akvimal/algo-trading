FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG VITE_MARKET_DATA_PORT=8001
ARG VITE_ACCOUNTS_PORT=8004
ENV VITE_MARKET_DATA_PORT=$VITE_MARKET_DATA_PORT
ENV VITE_ACCOUNTS_PORT=$VITE_ACCOUNTS_PORT
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
