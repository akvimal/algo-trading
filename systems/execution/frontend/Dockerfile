FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
ARG VITE_API_BASE_URL=/api
ARG VITE_MARKET_DATA_PORT=8001
ARG VITE_SIGNAL_GENERATION_PORT=8003
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_MARKET_DATA_PORT=$VITE_MARKET_DATA_PORT
ENV VITE_SIGNAL_GENERATION_PORT=$VITE_SIGNAL_GENERATION_PORT
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
