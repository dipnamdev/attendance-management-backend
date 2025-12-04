# Docker Connection Troubleshooting

## Issue: "localhost:5432 - no response" or "PostgreSQL is unavailable"

This happens when the Docker container tries to connect to `localhost`, which inside a container refers to the container itself, not your EC2 host machine.

## Solution

### Step 1: Update your `.env` file

Make sure your `DATABASE_URL` uses `host.docker.internal` instead of `localhost`:

```env
# ❌ WRONG - Don't use localhost
DATABASE_URL=postgresql://postgres:password@localhost:5432/attendance_db

# ✅ CORRECT - Use host.docker.internal
DATABASE_URL=postgresql://postgres:password@host.docker.internal:5432/attendance_db
```

### Step 2: If `host.docker.internal` doesn't work

Find your Docker bridge IP and use that instead:

```bash
# Find Docker bridge IP
ip addr show docker0 | grep "inet " | awk '{print $2}' | cut -d/ -f1

# Usually it's 172.17.0.1, so use:
DATABASE_URL=postgresql://postgres:password@172.17.0.1:5432/attendance_db
```

### Step 3: Verify PostgreSQL is accessible

**From EC2 host:**
```bash
# Test PostgreSQL is running
sudo systemctl status postgresql

# Test connection
psql -h localhost -U postgres -d attendance_db
```

**From Docker container (after rebuild):**
```bash
# Rebuild container
docker-compose up --build -d

# Test connection from container
docker-compose exec app pg_isready -h host.docker.internal -p 5432 -U postgres
```

### Step 4: Check PostgreSQL Configuration

**1. Verify PostgreSQL is listening:**
```bash
sudo netstat -tlnp | grep 5432
# Should show: 0.0.0.0:5432 or 127.0.0.1:5432
```

**2. Check pg_hba.conf allows Docker connections:**
```bash
sudo cat /etc/postgresql/15/main/pg_hba.conf | grep -v "^#" | grep -v "^$"
```

Add this line if missing:
```
host    all             all             172.17.0.0/16           md5
host    all             all             172.18.0.0/16           md5
```

**3. Restart PostgreSQL:**
```bash
sudo systemctl restart postgresql
```

## Quick Fix Commands

```bash
# 1. Stop containers
docker-compose down

# 2. Update .env file (use host.docker.internal or Docker bridge IP)
nano .env

# 3. Rebuild and start
docker-compose up --build

# 4. Check logs
docker-compose logs -f app
```

## What the Fixed Script Does

The updated Dockerfile now:
1. ✅ Automatically replaces `localhost` with `host.docker.internal` in the wait script
2. ✅ Shows better error messages with troubleshooting tips
3. ✅ Has a timeout (60 attempts = ~2 minutes) to prevent infinite waiting
4. ✅ Provides clear instructions if connection fails

## Still Having Issues?

1. **Check if host.docker.internal resolves:**
   ```bash
   docker-compose exec app ping -c 3 host.docker.internal
   ```

2. **Try Docker bridge IP instead:**
   ```bash
   # Find IP
   ip addr show docker0
   
   # Use in .env
   DATABASE_URL=postgresql://user:pass@172.17.0.1:5432/db
   ```

3. **Check firewall:**
   ```bash
   sudo ufw status
   sudo ufw allow from 172.17.0.0/16 to any port 5432
   ```

4. **Verify PostgreSQL user and database exist:**
   ```bash
   sudo -u postgres psql
   \du  # List users
   \l   # List databases
   ```

## Expected Output After Fix

When working correctly, you should see:
```
Waiting for database at host.docker.internal...
[1/60] PostgreSQL at host.docker.internal:5432 is unavailable - sleeping...
[2/60] PostgreSQL at host.docker.internal:5432 is unavailable - sleeping...
✅ PostgreSQL is up and ready at host.docker.internal:5432
Database is ready!
Running database migration...
✅ Database migration completed successfully!
Starting application...
🚀 Server running on port 3000
```

