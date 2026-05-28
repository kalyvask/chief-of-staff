FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the repo
COPY . .

# The server listens on 3030 by default
EXPOSE 3030

# Mount points: bring your own .env, your own data/, and (optionally) projects/
# The image ships the templates so a first-time user can `npm run cos:demo`
# in the container without mounting anything.
VOLUME ["/app/data", "/app/projects", "/app/memory", "/app/logs"]

# Default command runs the web UI server.
CMD ["node", "server.mjs"]
