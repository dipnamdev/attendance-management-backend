# Docker Configuration Fixes

## Issues Fixed

### 1. **Dockerfile Issues**
- ✅ **Fixed deprecated npm flag**: Changed `npm ci --only=production` to `npm ci` (installs all dependencies needed for migration scripts)
- ✅ **Added database wait script**: Created a `wait-for-db.sh` script that waits for PostgreSQL to be ready before starting the app
- ✅ **Added startup script**: Created `docker-entrypoint.sh` that:
  - Waits for database to be ready
  - Runs database migrations automatically
  - Starts the application
- ✅ **Added required tools**: Installed `postgresql-client` (for `pg_isready`) and `curl` (for healthcheck)

### 2. **docker-compose.yml Issues**
- ✅ **Fixed database healthcheck**: Changed from using `${DB_USER:-postgres}` (which doesn't expand in healthcheck) to hardcoded `postgres` (matches default)
- ✅ **Added app healthcheck**: Added healthcheck endpoint using `/health` route
- ✅ **Added Redis healthcheck**: Added healthcheck for Redis service
- ✅ **Improved environment variables**: Added explicit `DB_USER`, `DB_PASSWORD`, and `DB_NAME` environment variables
- ✅ **Added default values**: All environment variables now have sensible defaults
- ✅ **Added start periods**: Added `start_period` to healthchecks to allow services time to initialize

### 3. **.dockerignore Updates**
- ✅ **Fixed uploads directory**: Removed `uploads` from `.dockerignore` since it's mounted as a volume (needs to exist in container)
- ✅ **Kept logs excluded**: Logs directory remains excluded (will be created at runtime)

## How to Use

### Prerequisites
1. Create a `.env` file in the Backend directory (optional, defaults are provided):
```env
DB_USER=postgres
DB_PASSWORD=your_secure_password
DB_NAME=attendance_db
JWT_SECRET=your_very_secure_jwt_secret_key
JWT_EXPIRY=24h
SESSION_SECRET=your_session_secret
```

### Build and Run
```bash
# Build and start all services
docker-compose up --build

# Run in detached mode
docker-compose up -d --build

# View logs
docker-compose logs -f app

# Stop services
docker-compose down

# Stop and remove volumes (⚠️ deletes database data)
docker-compose down -v
```

### First Time Setup
On first run, the container will:
1. Wait for PostgreSQL to be ready
2. Automatically run database migrations
3. Start the application

**Note**: The migration script will drop existing tables if they exist. For production, consider using a proper migration strategy.

### Seeding Data (Optional)
To seed initial data (admin user, sample employees), you can run:
```bash
docker-compose exec app npm run seed
```

## Environment Variables

All environment variables can be set in `.env` file or directly in `docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_USER` | `postgres` | PostgreSQL username |
| `DB_PASSWORD` | `postgres` | PostgreSQL password |
| `DB_NAME` | `attendance_db` | Database name |
| `JWT_SECRET` | `change-this-secret-key-in-production` | JWT signing secret |
| `JWT_EXPIRY` | `24h` | JWT token expiration |
| `SESSION_SECRET` | `change-this-session-secret` | Session secret |
| `UPLOAD_DIR` | `/usr/src/app/uploads` | Upload directory (inside container) |
| `MAX_FILE_SIZE` | `5242880` | Max file size in bytes (5MB) |

## Important Notes

1. **Security**: Change default passwords and secrets before deploying to production!
2. **Data Persistence**: Database data is stored in a Docker volume (`postgres_data`). Use `docker-compose down -v` to remove it.
3. **Uploads**: The `uploads` directory is mounted as a volume, so files persist between container restarts.
4. **Migrations**: Migrations run automatically on container start. If migrations fail, the container will still start (with a warning).
5. **Health Checks**: All services have healthchecks configured. Use `docker-compose ps` to check service health.

## Troubleshooting

### Database Connection Issues
- Check that `DB_USER`, `DB_PASSWORD`, and `DB_NAME` match between app and db services
- Verify database is healthy: `docker-compose ps db`
- Check database logs: `docker-compose logs db`

### Migration Issues
- Check migration logs: `docker-compose logs app | grep -i migration`
- Run migration manually: `docker-compose exec app npm run migrate`
- Check database connection: `docker-compose exec app node -e "require('./src/config/database').query('SELECT 1')"`

### Application Won't Start
- Check all logs: `docker-compose logs`
- Verify environment variables: `docker-compose exec app env | grep -E 'DB_|JWT_'`
- Check health endpoint: `curl http://localhost:3000/health`

## Production Considerations

1. **Use strong secrets**: Generate secure random strings for `JWT_SECRET` and `SESSION_SECRET`
2. **Use strong database password**: Don't use default `postgres` password
3. **Configure proper CORS**: Update CORS settings in the application
4. **Set up backups**: Configure regular database backups
5. **Use reverse proxy**: Consider using nginx or traefik in front of the app
6. **Monitor logs**: Set up log aggregation and monitoring
7. **Resource limits**: Add resource limits to docker-compose.yml services

