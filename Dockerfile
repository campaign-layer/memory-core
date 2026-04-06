FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Build TypeScript
RUN npm install typescript
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

EXPOSE 7401

# Start the server
CMD ["npm", "start"]