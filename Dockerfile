FROM node:18-slim

# Install dependencies
RUN apt-get update && apt-get install -y curl unzip python3 groff less && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install AWS CLI
RUN curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip" && \
    unzip awscliv2.zip && ./aws/install && rm -rf aws awscliv2.zip

# Install kiro-cli (deb package)
RUN curl -fsSL -o kiro-cli.deb "https://desktop-release.codewhisperer.us-east-1.amazonaws.com/latest/linux/x64/kiro-cli.deb" && \
    dpkg -i kiro-cli.deb || apt-get install -f -y && \
    rm kiro-cli.deb

WORKDIR /app

COPY web/backend/package.json web/backend/
RUN cd web/backend && npm install --production

COPY web/ web/

RUN mkdir -p /data/projects
ENV PROJECTS_DIR=/data/projects
ENV PORT=3001

EXPOSE 3001

CMD ["node", "web/backend/server.js"]
