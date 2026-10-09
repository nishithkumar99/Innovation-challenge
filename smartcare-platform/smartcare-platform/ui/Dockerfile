# ---- build stage -------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx ng build --configuration production

# ---- runtime stage -----------------------------------------------------------
FROM nginx:1.27-alpine
COPY --from=build /app/dist/smartcare-logistics-ui/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# generates /config.js from environment variables every time the container starts
COPY docker-entrypoint.d/40-config.sh /docker-entrypoint.d/40-config.sh
RUN chmod +x /docker-entrypoint.d/40-config.sh
ENV SCL_BACKEND=real SCL_API_BASE=/api SCL_WS_URL=
EXPOSE 80
