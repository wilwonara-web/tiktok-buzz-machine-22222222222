FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Copy package descriptors
COPY package*.json ./

# Install dependencies (Playwright is already installed globally/in base image but we need the package bindings)
RUN npm ci

# Copy the rest of the application source code
COPY . .

# Expose port (Render sets PORT environment variable, defaults to 3000 here)
EXPOSE 3000

# Start command
CMD ["node", "server.js"]
