FROM node:18-slim

# Install AWS CLI and dependencies
RUN apt-get update && apt-get install -y curl unzip python3 && \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && ./aws/install && rm -rf aws awscliv2.zip && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install kiro-cli
RUN curl -fsSL https://kiro.dev/cli/install.sh | bash || \
    echo "Install kiro-cli manually if this fails"

WORKDIR /app

# Copy backend
COPY web/backend/package.json web/backend/
RUN cd web/backend && npm install --production

COPY web/ web/

# Data directory
RUN mkdir -p /data/projects
ENV PROJECTS_DIR=/data/projects
ENV PORT=3001

EXPOSE 3001

CMD ["node", "web/backend/server.js"]
