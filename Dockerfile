FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./

# Install all dependencies (including devDependencies) so we can build
RUN npm ci

COPY . .

# Build the project (and fail if it errors)
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8081

EXPOSE 8081

CMD ["node", "dist/main.js"]
