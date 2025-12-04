# EC2 PostgreSQL Setup Guide

This guide explains how to configure the Docker backend to use a local PostgreSQL database running on your EC2 instance.

## Prerequisites

1. PostgreSQL installed on EC2 instance
2. PostgreSQL configured to accept connections from Docker containers
3. `.env` file configured with correct database connection string

## Step 1: Install PostgreSQL on EC2

```bash
# On Ubuntu/Debian
sudo apt update
sudo apt install postgresql postgresql-contrib

# On Amazon Linux 2
sudo yum install postgresql15-server postgresql15

# Start PostgreSQL service
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

## Step 2: Configure PostgreSQL

### 2.1 Create Database and User

```bash
# Switch to postgres user
sudo -u postgres psql

# Create database
CREATE DATABASE attendance_db;

# Create user (replace 'your_password' with a strong password)
CREATE USER your_db_user WITH PASSWORD 'your_password';

# Grant privileges
GRANT ALL PRIVILEGES ON DATABASE attendance_db TO your_db_user;

# Exit psql
\q
```

### 2.2 Configure PostgreSQL to Accept Connections

Edit PostgreSQL configuration files:

```bash
# Find PostgreSQL config location
sudo -u postgres psql -c "SHOW config_file;"

# Edit postgresql.conf (usually /etc/postgresql/15/main/postgresql.conf)
sudo nano /etc/postgresql/15/main/postgresql.conf

# Find and update:
listen_addresses = '*'  # or 'localhost,172.17.0.1' for Docker bridge network
```

### 2.3 Configure pg_hba.conf for Docker Access

```bash
# Edit pg_hba.conf (usually /etc/postgresql/15/main/pg_hba.conf)
sudo nano /etc/postgresql/15/main/pg_hba.conf

# Add these lines (adjust IP range based on your Docker network):
# Allow Docker containers to connect
host    all             all             172.17.0.0/16           md5
host    all             all             172.18.0.0/16           md5
host    all             all             172.19.0.0/16           md5
host    all             all             172.20.0.0/16           md5

# Or allow all local connections (less secure, but simpler)
host    all             all             127.0.0.1/32            md5
host    all             all             ::1/128                  md5
```

### 2.4 Restart PostgreSQL

```bash
sudo systemctl restart postgresql

# Verify PostgreSQL is running
sudo systemctl status postgresql
```

## Step 3: Configure .env File

Update your `.env` file in the Backend directory:

```env
# Database Configuration
# Option 1: Using host.docker.internal (recommended)
DATABASE_URL=postgresql://your_db_user:your_password@host.docker.internal:5432/attendance_db

# Option 2: Using Docker bridge gateway IP (if host.docker.internal doesn't work)
# Find Docker bridge IP: ip addr show docker0 | grep inet
# DATABASE_URL=postgresql://your_db_user:your_password@172.17.0.1:5432/attendance_db

# Option 3: Using host's private IP (if on same network)
# DATABASE_URL=postgresql://your_db_user:your_password@<EC2_PRIVATE_IP>:5432/attendance_db

# Application Configuration
NODE_ENV=production
PORT=3000

# JWT Configuration
JWT_SECRET=your-very-secure-jwt-secret-key-change-this
JWT_EXPIRY=24h
SESSION_SECRET=your-session-secret-change-this

# File Upload
UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880

# Redis (optional - can use containerized Redis)
REDIS_HOST=redis
REDIS_PORT=6379
```

## Step 4: Find Docker Bridge IP (if needed)

If `host.docker.internal` doesn't work, find your Docker bridge IP:

```bash
# Check Docker bridge network
ip addr show docker0

# Or check default gateway
docker network inspect bridge | grep Gateway
```

Use the IP address (usually `172.17.0.1`) in your `DATABASE_URL`.

## Step 5: Test Database Connection

### From Host Machine

```bash
# Test connection from host
psql -h localhost -U your_db_user -d attendance_db

# Or using connection string
psql postgresql://your_db_user:your_password@localhost:5432/attendance_db
```

### From Docker Container

```bash
# Build and start container
docker-compose up --build

# In another terminal, exec into container
docker-compose exec app sh

# Test database connection
pg_isready -h host.docker.internal -p 5432 -U your_db_user

# Or test with psql
psql postgresql://your_db_user:your_password@host.docker.internal:5432/attendance_db
```

## Step 6: Firewall Configuration

Ensure PostgreSQL port (5432) is accessible:

```bash
# Check if port is open
sudo netstat -tlnp | grep 5432

# If using AWS Security Groups, ensure:
# - Inbound rule allows TCP port 5432 from your Docker network or localhost
# - For EC2, you might want to restrict to localhost/private IP only

# Ubuntu/Debian firewall
sudo ufw allow from 172.17.0.0/16 to any port 5432
sudo ufw allow from 172.18.0.0/16 to any port 5432

# Or allow localhost only (more secure)
sudo ufw allow from 127.0.0.1 to any port 5432
```

## Step 7: Run Docker Compose

```bash
# Navigate to Backend directory
cd Backend

# Build and start services
docker-compose up --build -d

# Check logs
docker-compose logs -f app

# Verify database connection in logs
docker-compose logs app | grep -i "database\|postgres\|migration"
```

## Troubleshooting

### Issue: Cannot connect to database

**Solution 1**: Check PostgreSQL is running
```bash
sudo systemctl status postgresql
```

**Solution 2**: Check PostgreSQL is listening on correct address
```bash
sudo netstat -tlnp | grep 5432
# Should show: 0.0.0.0:5432 or 127.0.0.1:5432
```

**Solution 3**: Check pg_hba.conf configuration
```bash
sudo cat /etc/postgresql/15/main/pg_hba.conf | grep -v "^#"
```

**Solution 4**: Test connection from host first
```bash
psql -h localhost -U your_db_user -d attendance_db
```

**Solution 5**: Check Docker network connectivity
```bash
docker-compose exec app ping -c 3 host.docker.internal
# Or try with Docker bridge IP
docker-compose exec app ping -c 3 172.17.0.1
```

### Issue: host.docker.internal not resolving

**Solution**: Use Docker bridge IP instead
```bash
# Find Docker bridge IP
ip addr show docker0 | grep "inet " | awk '{print $2}' | cut -d/ -f1

# Update DATABASE_URL in .env to use this IP
DATABASE_URL=postgresql://user:pass@172.17.0.1:5432/attendance_db
```

### Issue: Authentication failed

**Solution**: Verify user credentials and pg_hba.conf
```bash
# Reset password
sudo -u postgres psql
ALTER USER your_db_user WITH PASSWORD 'new_password';
\q

# Update .env with new password
```

### Issue: Migration fails

**Solution**: Run migration manually
```bash
docker-compose exec app npm run migrate
```

## Security Best Practices

1. **Use strong passwords** for database users
2. **Restrict pg_hba.conf** to specific IP ranges (Docker networks)
3. **Don't expose PostgreSQL port** to public internet (use Security Groups)
4. **Use SSL/TLS** for database connections in production
5. **Regular backups** of PostgreSQL database
6. **Monitor database logs** for suspicious activity

## Production Considerations

1. **SSL Connection**: Update `DATABASE_URL` to use SSL:
   ```
   DATABASE_URL=postgresql://user:pass@host:5432/db?sslmode=require
   ```

2. **Connection Pooling**: Consider using PgBouncer for connection pooling

3. **Backup Strategy**: Set up automated PostgreSQL backups

4. **Monitoring**: Monitor database performance and connections

5. **High Availability**: Consider PostgreSQL replication for production

## Alternative: Use Containerized PostgreSQL (Development Only)

If you prefer to use containerized PostgreSQL for development:

1. Uncomment the `db` service in `docker-compose.yml`
2. Update `DATABASE_URL` to use `db` as hostname
3. Add `db` back to `depends_on` in app service

**Note**: This is not recommended for production on EC2 as it adds unnecessary overhead.

