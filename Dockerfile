# Use official Node.js lightweight image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files first (better caching)
COPY package*.json ./

# Install only production dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Cloud Run injects PORT environment variable, but valid default is 3000
ENV PORT=3000
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
