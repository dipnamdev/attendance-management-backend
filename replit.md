# Attendance Management System Backend

## Project Overview
A complete backend API for tracking employee attendance, activity monitoring, screenshot capture, and productivity analytics built with Node.js, Express, and PostgreSQL.

## Current Status
✅ **Production Ready** - Server running on port 3000

## Architecture

### Technology Stack
- **Backend**: Node.js 20 + Express.js
- **Database**: PostgreSQL (Neon-backed via Replit)
- **Authentication**: JWT with bcrypt
- **File Storage**: Local filesystem with Sharp for image processing
- **Caching**: Redis (optional - gracefully degrades without it)
- **Scheduling**: node-cron for background jobs

### Database Schema
8 main tables with comprehensive indexing:
1. `users` - User accounts (admin/employee roles)
2. `attendance_records` - Daily check-in/check-out records
3. `activity_logs` - Activity type tracking (active/idle/break)
4. `user_activity_tracking` - Detailed activity metrics
5. `screenshots` - Screenshot metadata and file paths
6. `lunch_breaks` - Break time tracking
7. `productivity_summary` - Daily aggregated metrics
8. `system_settings` - Configurable system parameters

## Key Features

### Authentication & Authorization
- JWT-based authentication with configurable expiry
- Role-based access control (Admin/Employee)
- Rate limiting on login (5 attempts per 15 minutes)
- Secure password hashing with bcrypt (10 rounds)
- Configuration validation on startup (fails fast if critical secrets missing)

### Attendance Management
- Daily check-in/check-out with IP and location tracking
- Automatic duration calculations
- Status tracking (present, absent, half_day, on_leave)
- Notes support for attendance records

### Activity Tracking
- Real-time heartbeat API (30-second intervals)
- Automatic idle detection (5-minute threshold)
- Mouse clicks and keyboard strokes counting
- Active window and application tracking
- URL tracking for web activity

### Productivity Analytics
- Daily aggregation job (runs at midnight)
- Productivity score calculation (active time %)
- Top applications and websites tracking
- Screenshot counting and metadata
- Daily/weekly/monthly report generation

### Screenshot Management
- Multipart file upload support
- Automatic thumbnail generation (200x150px)
- File size tracking
- Metadata capture (window title, application, resolution)
- Secure access control (employees see own, admins see all)

## API Endpoints

### Public
- `GET /` - API information
- `GET /health` - Health check
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login (rate limited)

### Authenticated (Employee & Admin)
- `POST /api/auth/logout` - Logout
- `POST /api/auth/refresh-token` - Refresh JWT
- `GET /api/auth/me` - Get current user
- `POST /api/attendance/check-in` - Check in
- `POST /api/attendance/check-out` - Check out
- `GET /api/attendance/status` - Current status
- `GET /api/attendance/today` - Today's attendance
- `GET /api/attendance/history` - Attendance history
- `POST /api/activity/heartbeat` - Send activity heartbeat
- `GET /api/activity/current` - Current activity
- `GET /api/activity/history` - Activity history
- `POST /api/lunch-break/start` - Start lunch break
- `POST /api/lunch-break/end` - End lunch break
- `GET /api/lunch-break/current` - Current break status
- `POST /api/screenshots/upload` - Upload screenshot
- `GET /api/screenshots/list` - List screenshots
- `GET /api/screenshots/:id` - Get screenshot details
- `DELETE /api/screenshots/:id` - Delete screenshot
- `GET /api/settings` - Get all settings

### Admin Only
- `GET /api/reports/daily` - Daily report
- `GET /api/reports/weekly` - Weekly report
- `GET /api/reports/monthly` - Monthly report
- `GET /api/reports/productivity-summary` - Productivity summary
- `GET /api/reports/team-overview` - Team overview
- `GET /api/users` - List all users
- `POST /api/users` - Create user
- `GET /api/users/:id` - Get user details
- `PUT /api/users/:id` - Update user
- `DELETE /api/users/:id` - Delete user
- `GET /api/users/:id/attendance-summary` - User attendance summary
- `PUT /api/settings/:key` - Update system setting

## Environment Configuration

### Required Secrets (via Replit Secrets)
- `JWT_SECRET` - Secret key for signing JWT tokens (required)
- `DATABASE_URL` - PostgreSQL connection string (auto-configured by Replit)

### Optional Environment Variables
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (development/production)
- `JWT_EXPIRY` - Token expiration time (default: 24h)
- `UPLOAD_DIR` - Upload directory (default: ./uploads)
- `MAX_FILE_SIZE` - Max upload size in bytes (default: 5MB)
- `REDIS_HOST` - Redis host (default: localhost)
- `REDIS_PORT` - Redis port (default: 6379)

## User Credentials

### Admin Account
- Email: `admin@company.com`
- Password: `employee123`
- Role: admin
- Employee ID: EMP001

### Employee Accounts
All employees use password: `employee123`
- `john.doe@company.com` (EMP002)
- `jane.smith@company.com` (EMP003)
- `mike.johnson@company.com` (EMP004)

## Business Logic

### Check-in Flow
1. Validates no existing check-in for today
2. Creates attendance_record with current timestamp
3. Records IP address and optional location
4. Starts initial "active" activity_log
5. Caches attendance in Redis (if available)

### Activity Heartbeat Flow
1. Receives activity data every 30 seconds
2. Stores in user_activity_tracking table
3. Checks time since last heartbeat
4. If >5 minutes of inactivity:
   - Closes current "active" log
   - Creates "idle" log starting 5 minutes ago
5. If resuming from idle:
   - Closes "idle" log
   - Creates new "active" log
6. Caches current state in Redis

### Check-out Flow
1. Validates user is checked in
2. Closes all open activity_logs
3. Closes any open lunch_breaks
4. Calculates totals:
   - total_work_duration = checkout_time - checkin_time
   - total_active_duration = SUM(active activity_logs)
   - total_idle_duration = SUM(idle activity_logs)
   - total_break_duration = SUM(lunch_breaks)
5. Updates attendance_record
6. Clears Redis cache

### Daily Aggregation (Midnight)
For each previous day's attendance:
1. Aggregates activity log durations
2. Counts screenshots
3. Sums mouse clicks and keyboard strokes
4. Identifies top 10 applications by usage
5. Identifies top 10 websites by visits
6. Calculates productivity_score = (active_time / total_time) × 100
7. Inserts/updates productivity_summary record

## File Structure

```
attendance-backend/
├── src/
│   ├── config/
│   │   ├── database.js - PostgreSQL pool configuration
│   │   └── redis.js - Redis client with graceful fallback
│   ├── middleware/
│   │   ├── auth.js - JWT authentication & RBAC
│   │   └── errorHandler.js - Centralized error handling
│   ├── routes/ - API route definitions
│   ├── controllers/ - Request handlers
│   ├── services/ - Business logic layer
│   ├── utils/
│   │   ├── helpers.js - Utility functions
│   │   ├── validators.js - Request validation
│   │   ├── logger.js - Logging utility
│   │   ├── migrate.js - Database migration script
│   │   ├── seed.js - Seed data script
│   │   └── configValidation.js - Startup config validation
│   ├── jobs/
│   │   └── dailyAggregation.js - Daily productivity aggregation
│   └── index.js - Server entry point
├── uploads/ - File storage (screenshots)
├── test.http - API test requests
├── package.json
└── README.md
```

## Security Implementations

✅ **Authentication**: JWT tokens with configurable expiry
✅ **Authorization**: Role-based access control (employee/admin)
✅ **Password Security**: bcrypt with 10 rounds
✅ **Rate Limiting**: Login endpoint limited to 5 attempts/15min
✅ **Input Validation**: express-validator on all inputs
✅ **SQL Injection Protection**: Parameterized queries only
✅ **Configuration Validation**: Fails fast on missing secrets
✅ **File Upload Validation**: Type and size restrictions
✅ **CORS**: Enabled for cross-origin requests
✅ **Error Handling**: No sensitive data in error responses

## Known Limitations

1. **Redis Optional**: System works without Redis but loses caching benefits
2. **Refresh Tokens**: Stateless JWT refresh (no persistent token store/blacklist)
3. **Single Check-in**: One check-in per day (no shift changes or re-entry support)
4. **Local Storage**: Screenshots stored locally (not cloud-scalable)
5. **Export Stub**: Report export endpoint not implemented (returns "coming soon")

## Development Commands

```bash
npm install          # Install dependencies
npm run migrate      # Run database migrations
npm run seed         # Seed initial data
npm start            # Start server
npm run dev          # Start server (same as start)
```

## Testing

Use the `test.http` file with REST Client extension or Postman:
1. Login to get JWT token
2. Copy token to replace `{{token}}` placeholder
3. Test endpoints in sequence

## Recent Changes

- Added JWT_SECRET validation on startup
- Removed fallback to insecure default secrets
- Made Redis gracefully optional
- Added comprehensive error handling
- Implemented configuration validation
- Fixed port binding issues

## Future Enhancements

- WebSocket support for real-time updates
- Persistent refresh token storage with blacklist
- Multiple check-ins per day (shift support)
- S3 integration for screenshot storage
- CSV/PDF report export
- Email notifications
- Advanced productivity categorization
- Machine learning for productivity insights
