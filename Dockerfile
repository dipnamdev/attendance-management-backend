FROM node:18-alpine

# Install wait-for script dependencies and curl for healthcheck
RUN apk add --no-cache postgresql-client curl

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
COPY package*.json ./

# Install all dependencies (needed for migration scripts)
RUN npm ci

# Copy app source
COPY . .

# Create wait-for-db script
RUN echo '#!/bin/sh' > /usr/local/bin/wait-for-db.sh && \
    echo 'set -e' >> /usr/local/bin/wait-for-db.sh && \
    echo 'host="$1"' >> /usr/local/bin/wait-for-db.sh && \
    echo 'db_user="${DB_USER:-postgres}"' >> /usr/local/bin/wait-for-db.sh && \
    echo 'shift' >> /usr/local/bin/wait-for-db.sh && \
    echo 'cmd="$@"' >> /usr/local/bin/wait-for-db.sh && \
    echo 'max_attempts=60' >> /usr/local/bin/wait-for-db.sh && \
    echo 'attempt=0' >> /usr/local/bin/wait-for-db.sh && \
    echo 'echo "Waiting for PostgreSQL at $host:5432 (user: $db_user)..."' >> /usr/local/bin/wait-for-db.sh && \
    echo 'until pg_isready -h "$host" -p 5432 -U "$db_user" >/dev/null 2>&1; do' >> /usr/local/bin/wait-for-db.sh && \
    echo '  attempt=$((attempt + 1))' >> /usr/local/bin/wait-for-db.sh && \
    echo '  if [ $attempt -ge $max_attempts ]; then' >> /usr/local/bin/wait-for-db.sh && \
    echo '    >&2 echo "ERROR: PostgreSQL at $host:5432 is still unavailable after $max_attempts attempts"' >> /usr/local/bin/wait-for-db.sh && \
    echo '    >&2 echo "Please check:"' >> /usr/local/bin/wait-for-db.sh && \
    echo '    >&2 echo "  1. PostgreSQL is running on the host"' >> /usr/local/bin/wait-for-db.sh && \
    echo '    >&2 echo "  2. PostgreSQL is listening on port 5432"' >> /usr/local/bin/wait-for-db.sh && \
    echo '    >&2 echo "  3. pg_hba.conf allows connections from Docker network"' >> /usr/local/bin/wait-for-db.sh && \
    echo '    >&2 echo "  4. DATABASE_URL in .env uses host.docker.internal or Docker bridge IP"' >> /usr/local/bin/wait-for-db.sh && \
    echo '    exit 1' >> /usr/local/bin/wait-for-db.sh && \
    echo '  fi' >> /usr/local/bin/wait-for-db.sh && \
    echo '  >&2 echo "[$attempt/$max_attempts] PostgreSQL at $host:5432 is unavailable - sleeping..."' >> /usr/local/bin/wait-for-db.sh && \
    echo '  sleep 2' >> /usr/local/bin/wait-for-db.sh && \
    echo 'done' >> /usr/local/bin/wait-for-db.sh && \
    echo '>&2 echo "✅ PostgreSQL is up and ready at $host:5432"' >> /usr/local/bin/wait-for-db.sh && \
    echo 'exec $cmd' >> /usr/local/bin/wait-for-db.sh && \
    chmod +x /usr/local/bin/wait-for-db.sh

# Create startup script
RUN echo '#!/bin/sh' > /usr/src/app/docker-entrypoint.sh && \
    echo 'set -e' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'export DB_USER="${DB_USER:-postgres}"' >> /usr/src/app/docker-entrypoint.sh && \
    echo '# Extract database host from DATABASE_URL' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'DB_HOST="${DB_HOST:-host.docker.internal}"' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'if [ -n "$DATABASE_URL" ]; then' >> /usr/src/app/docker-entrypoint.sh && \
    echo '  # Extract host from DATABASE_URL if present' >> /usr/src/app/docker-entrypoint.sh && \
    echo '  EXTRACTED_HOST=$(echo "$DATABASE_URL" | sed -n "s|.*@\([^:]*\):.*|\1|p")' >> /usr/src/app/docker-entrypoint.sh && \
    echo '  if [ -n "$EXTRACTED_HOST" ]; then' >> /usr/src/app/docker-entrypoint.sh && \
    echo '    # Replace localhost with host.docker.internal for Docker containers' >> /usr/src/app/docker-entrypoint.sh && \
    echo '    if [ "$EXTRACTED_HOST" = "localhost" ] || [ "$EXTRACTED_HOST" = "127.0.0.1" ]; then' >> /usr/src/app/docker-entrypoint.sh && \
    echo '      DB_HOST="host.docker.internal"' >> /usr/src/app/docker-entrypoint.sh && \
    echo '    else' >> /usr/src/app/docker-entrypoint.sh && \
    echo '      DB_HOST="$EXTRACTED_HOST"' >> /usr/src/app/docker-entrypoint.sh && \
    echo '    fi' >> /usr/src/app/docker-entrypoint.sh && \
    echo '  fi' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'fi' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'echo "Waiting for database at $DB_HOST..."' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'wait-for-db.sh "$DB_HOST"' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'echo "Database is ready!"' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'echo "Running database migration..."' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'npm run migrate || echo "Migration failed or already completed"' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'echo "Starting application..."' >> /usr/src/app/docker-entrypoint.sh && \
    echo 'exec npm start' >> /usr/src/app/docker-entrypoint.sh && \
    chmod +x /usr/src/app/docker-entrypoint.sh

# Expose the port the app runs on
EXPOSE 3000

# Start the application using entrypoint script
CMD [ "/usr/src/app/docker-entrypoint.sh" ]
