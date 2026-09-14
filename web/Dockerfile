FROM node:22-alpine AS build
WORKDIR /app
ARG VITE_API_URL=/api
ARG VITE_WS_URL=/events
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# Pre-compress the build output once, at the best ratio gzip offers, so nginx
# can serve the .gz with gzip_static instead of compressing the same bundle on
# every request (see nginx.conf — brotli is not available on this base image).
# -k keeps the plain file for clients that don't accept gzip.
RUN find /app/dist -type f \
    \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' \
       -o -name '*.json' -o -name '*.txt' -o -name '*.webmanifest' \) \
    -size +1k -exec gzip -9 -k {} +

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
