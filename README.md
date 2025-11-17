# Attendance Management System Backend

A comprehensive backend API for tracking employee attendance, activity monitoring, screenshot capture, and productivity analytics.

## Features

- **User Authentication**: JWT-based authentication with role-based access control (Admin/Employee)
- **Attendance Tracking**: Check-in/check-out with duration tracking, IP logging, and location capture
- **Activity Monitoring**: Real-time heartbeat tracking with idle detection (5-minute threshold)
- **Lunch Break Management**: Track break times with automatic activity pause/resume
- **Screenshot Capture**: Upload and store screenshots with metadata and thumbnail generation
- **Productivity Reports**: Daily, weekly, and monthly reports with productivity metrics
- **User Management**: Admin panel for managing employees and viewing team analytics
- **Background Jobs**: Automated daily aggregation for productivity summaries
- **Settings Management**: Configurable system settings

## Technology Stack

- **Runtime**: Node.js with Express.js
- **Database**: PostgreSQL
- **Caching**: Redis (optional)
- **Authentication**: JWT tokens with bcrypt password hashing
- **File Storage**: Local storage with Sharp for image processing
- **Scheduling**: node-cron for background jobs
- **Validation**: express-validator
- **Logging**: Morgan + custom logger

## Prerequisites

- Node.js 18+ 
- PostgreSQL database
- Redis (optional, for caching)

## Installation

1. **Clone the repository**
```bash
git clone <repository-url>
cd attendance-backend
```

2. **Install dependencies**
```bash
npm install
```

3. **Environment Configuration**

Create a `.env` file in the root directory:

```env
PORT=3000
NODE_ENV=development

DATABASE_URL=postgresql://user:password@localhost:5432/attendance_db

JWT_SECRET=your-secret-key-change-this-in-production
JWT_EXPIRY=24h
SESSION_SECRET=your-session-secret-change-this

UPLOAD_DIR=./uploads
MAX_FILE_SIZE=5242880

REDIS_HOST=localhost
REDIS_PORT=6379
```

4. **Run Database Migration**
```bash
npm run migrate
```

5. **Seed Database**
```bash
npm run seed
```

This creates:
- 1 Admin user: `admin@company.com` / `employee123`
- 3 Employee users (all with password: `employee123`):
  - `john.doe@company.com`
  - `jane.smith@company.com`
  - `mike.johnson@company.com`
- Default system settings

**Note**: The seed script uses a pre-hashed password. If you need to change passwords, use the bcrypt hash for `employee123` or update the seed script with your own hashed passwords.

6. **Start the Server**
```bash
npm start
```

Server will start on `http://localhost:3000`

## API Endpoints

### Authentication
```
POST   /api/auth/register         - Register new user
POST   /api/auth/login            - Login user
POST   /api/auth/logout           - Logout user
POST   /api/auth/refresh-token    - Refresh JWT token
GET    /api/auth/me               - Get current user
```

### Attendance Management
```
POST   /api/attendance/check-in              - Check in for the day
POST   /api/attendance/check-out             - Check out
GET    /api/attendance/status                - Get current status
GET    /api/attendance/today                 - Get today's attendance
GET    /api/attendance/history               - Get attendance history
PUT    /api/attendance/:id/notes             - Update attendance notes
```

### Activity Tracking
```
POST   /api/activity/heartbeat               - Send activity heartbeat
POST   /api/activity/log                     - Log activity
GET    /api/activity/current                 - Get current activity
GET    /api/activity/history                 - Get activity history
```

### Lunch Breaks
```
POST   /api/lunch-break/start                - Start lunch break
POST   /api/lunch-break/end                  - End lunch break
GET    /api/lunch-break/current              - Get current break
```

### Screenshots
```
POST   /api/screenshots/upload               - Upload screenshot
GET    /api/screenshots/list                 - List screenshots
GET    /api/screenshots/:id                  - Get screenshot details
DELETE /api/screenshots/:id                  - Delete screenshot
```

### Reports (Admin Only)
```
GET    /api/reports/daily                    - Daily report
GET    /api/reports/weekly                   - Weekly report
GET    /api/reports/monthly                  - Monthly report
GET    /api/reports/productivity-summary     - Productivity summary
GET    /api/reports/team-overview            - Team overview
GET    /api/reports/export                   - Export report (coming soon)
```

### User Management (Admin Only)
```
GET    /api/users                            - Get all users
POST   /api/users                            - Create new user
GET    /api/users/:id                        - Get user by ID
PUT    /api/users/:id                        - Update user
DELETE /api/users/:id                        - Delete user
GET    /api/users/:id/attendance-summary     - User attendance summary
```

### Settings
```
GET    /api/settings                         - Get all settings
PUT    /api/settings/:key                    - Update setting (admin only)
```

## Database Schema

The system uses 8 main tables:

1. **users** - User accounts and profiles
2. **attendance_records** - Daily attendance records
3. **activity_logs** - Activity type logs (active, idle, break)
4. **user_activity_tracking** - Detailed activity tracking
5. **screenshots** - Screenshot metadata and storage
6. **lunch_breaks** - Lunch break records
7. **productivity_summary** - Daily productivity aggregates
8. **system_settings** - System configuration

## Key Business Logic

### Check-in Process
1. Creates `attendance_record` for today
2. Starts active `activity_log`
3. Records IP address and location
4. Returns attendance record ID

### Activity Heartbeat (every 30 seconds)
1. Receives activity data from client
2. Stores in `user_activity_tracking`
3. Updates current `activity_log`
4. Auto-detects idle state (5+ minutes of inactivity)
5. Caches status in Redis (optional)

### Idle Detection
- If no heartbeat for 5 minutes → marks as idle
- Creates idle `activity_log` entry
- When activity resumes → closes idle log, creates active log

### Check-out Process
1. Closes all open `activity_logs`
2. Closes open `lunch_breaks`
3. Calculates totals:
   - `total_work_duration` = checkout - checkin
   - `total_active_duration` = sum of active logs
   - `total_idle_duration` = sum of idle logs
   - `total_break_duration` = sum of breaks
4. Updates `attendance_record`

### Daily Aggregation (runs at midnight)
For each user's previous day attendance:
1. Calculates final durations from activity logs
2. Counts total screenshots
3. Sums mouse clicks and keyboard strokes
4. Aggregates top applications and websites
5. Calculates productivity score (active time %)
6. Inserts into `productivity_summary`

## Security Features

- ✅ Password hashing with bcrypt (10 rounds)
- ✅ JWT authentication on all protected routes
- ✅ Role-based access control (employee vs admin)
- ✅ Rate limiting on login endpoint (5 attempts per 15 minutes)
- ✅ File upload validation (type, size limits)
- ✅ SQL injection protection via parameterized queries
- ✅ CORS enabled
- ✅ Input validation using express-validator

## Error Handling

All errors return consistent JSON format:

**Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```

**Success Response:**
```json
{
  "success": true,
  "data": { ... },
  "message": "Optional success message"
}
```

## Testing

Use the provided `test.http` file with REST Client extension in VS Code, or import into Postman.

### Quick Test Flow:
1. Login as admin or employee
2. Copy the JWT token from response
3. Check in
4. Send activity heartbeat
5. Upload screenshot (optional)
6. Start/end lunch break
7. Check out
8. Get daily report

## Background Jobs

**Daily Aggregation** - Runs at midnight (00:00)
- Aggregates previous day's attendance data
- Calculates productivity metrics
- Generates daily summaries

## File Storage

Screenshots are stored in:
```
./uploads/screenshots/{user_id}/{date}/{timestamp}.jpg
./uploads/screenshots/{user_id}/{date}/thumb_{timestamp}.jpg
```

## Development

```bash
npm run dev
```

## Project Structure

```
attendance-backend/
├── src/
│   ├── config/
│   │   ├── database.js          # PostgreSQL connection
│   │   └── redis.js             # Redis client (optional)
│   ├── middleware/
│   │   ├── auth.js              # JWT authentication
│   │   └── errorHandler.js     # Error handling
│   ├── routes/                  # API route definitions
│   ├── controllers/             # Request handlers
│   ├── services/                # Business logic
│   ├── utils/
│   │   ├── helpers.js           # Utility functions
│   │   ├── validators.js        # Request validators
│   │   ├── logger.js            # Logging utility
│   │   ├── migrate.js           # Database migration
│   │   └── seed.js              # Seed data script
│   ├── jobs/
│   │   └── dailyAggregation.js  # Background job
│   └── index.js                 # Server entry point
├── uploads/                     # File storage
├── test.http                    # API test requests
├── package.json
└── README.md
```

## API Response Examples

### Successful Login
```json
{
  "success": true,
  "data": {
    "user": {
      "id": "uuid",
      "email": "admin@company.com",
      "name": "Admin User",
      "role": "admin"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "message": "Login successful"
}
```

### Daily Report
```json
{
  "success": true,
  "data": {
    "report": {
      "attendance": { ... },
      "activities": [ ... ],
      "screenshot_count": 48,
      "top_applications": [ ... ],
      "total_mouse_clicks": 1234,
      "total_keyboard_strokes": 5678
    }
  }
}
```

## Notes

- Redis is optional - the system will continue to work without it (caching disabled)
- Screenshot thumbnails are auto-generated at 200x150px
- All timestamps are stored in UTC
- Productivity score is calculated as: (active_time / total_work_time) × 100
- Employees can only access their own data
- Admins have full access to all user data

## License

ISC

## Support

For issues or questions, please create an issue in the repository.
