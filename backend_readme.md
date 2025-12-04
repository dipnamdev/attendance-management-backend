# Attendance Backend Deep Dive

Comprehensive reference for the Node/Express backend that powers the Attendance Management System. The server entry point is `src/index.js`, which wires middleware, route modules, and the nightly aggregation job.

---

## Getting Started

1. `cd Backend && npm install`
2. Configure `.env` (see next section).
3. Initialize Postgres data: `npm run setup` (runs ensure-database → migrations → seed).
4. Start the API: `npm start` (production) or `npm run dev`.
5. Optional: keep Redis running if you want caching for current attendance/activity snapshots; the API falls back gracefully when Redis is not reachable.

### Environment Variables

| Name | Required | Default | Used in | Notes |
| --- | --- | --- | --- | --- |
| `PORT` | No | `3000` | `src/index.js` | Express listen port. |
| `NODE_ENV` | No | `development` | logging, `logger.js` | Enables verbose logging when `development`. |
| `DATABASE_URL` | **Yes** | – | `config/database.js`, migrations, seeds | Full Postgres connection string; `ensureDatabase` derives admin URL from it. |
| `JWT_SECRET` | **Yes** | – | `middleware/auth.js`, `authController.js` | Must be non-default; app exits if it matches the placeholder. |
| `JWT_EXPIRY` | No | `24h` | `authController.js` | Token TTL. |
| `SESSION_SECRET` | No | `your-session-secret-change-this` | `configValidation.js` | Warned if left default. |
| `REDIS_HOST` / `REDIS_PORT` | No | `localhost:6379` | `config/redis.js` | Skip to run without caching. |
| `UPLOAD_DIR` | No | `./uploads` | `screenshotController.js` | Root for screenshot storage. |
| `MAX_FILE_SIZE` | No | `5 * 1024 * 1024` | `screenshotController.js` | Upload max in bytes. |

### Useful Scripts (`package.json`)

| Script | Description |
| --- | --- |
| `npm run migrate` | Drops and recreates Postgres schema defined in `src/utils/migrate.js`. |
| `npm run seed` | Inserts the default admin/employees + baseline settings. |
| `npm run setup` | Convenience wrapper: ensure database → migrate → seed. |

Seeded credentials live in `src/utils/seed.js` (admin `admin@company.com` / `admin123`, employees `employee123`).

---

## Runtime Architecture

* **Express stack**: `src/index.js` registers CORS, JSON parsing, logging (`morgan`), and injects route modules under `/api/*`.
* **AuthN/AuthZ**: JWT bearer tokens via `middleware/auth.js`; `authorizeRoles` gate-keeps admin-only routes. Login attempts are rate-limited (5 per 15 minutes) using `express-rate-limit`.
* **Persistence**: PostgreSQL via `pg` pool (`src/config/database.js`). Business logic lives inside service classes (`src/services/*`) and uses parameterized SQL.
* **Caching**: Optional Redis layer (`config/redis.js`) for the current attendance object (`user:{id}:attendance`) and the most recent heartbeat metadata (`user:{id}:last_activity`).
* **File storage**: `multer` + `sharp` write screenshots to `uploads/screenshots/{user_id}/{YYYY-MM-DD}/`.
* **Background work**: `node-cron` schedules `jobs/dailyAggregation.js` at midnight to populate `productivity_summary`.
* **Error/validation**: Consistent response helpers in `utils/helpers.js`. Validation handled through `express-validator` middleware in `utils/validators.js`. Central error handler lives in `middleware/errorHandler.js`.

`test.http` contains ready-to-run REST Client snippets that walk through the entire flow (health, auth, attendance, activity, breaks, screenshots, reports, admin management).

---

## Database Schema & Relationships

> Defined in `src/utils/migrate.js`. All timestamps are UTC. UUID primary keys leverage `gen_random_uuid()`. Indexes exist on all FK/lookup-heavy columns for query speed.

### `users`
Purpose: account master data.

Key columns:
- `id` (UUID, PK)
- `email` (unique), `password_hash` (bcrypt hash)
- `name`, `employee_id` (unique), `role` (`employee` \| `admin` \| `hr`)
- `status` (`active`/`inactive`/`terminated`)
- `profile_picture_url`, audit columns

Referenced by every other table through `user_id`.

### `attendance_records`
One per user per calendar date.

Important fields:
- `user_id` (FK → `users.id`)
- `date` (ISO date) with `unique(user_id, date)`
- `check_in_time`, `check_out_time`, IP/location JSON
- Computed totals: `total_work_duration`, `total_active_duration`, `total_idle_duration`, `total_break_duration`
- `status` flag (present/absent/half_day/on_leave)

### `activity_logs`
Captures contiguous stretches of a single `activity_type`.

Fields:
- `user_id`, `attendance_record_id` (FK)
- `activity_type`: `active`, `idle`, `lunch_break`, `meeting`
- `start_time`, `end_time`, `duration`

Used to calculate active/idle/break time during checkout and reporting.

### `user_activity_tracking`
High-frequency heartbeats for desktop monitoring.

Fields:
- `timestamp`
- Application context (`active_window_title`, `active_application`, `url`)
- Input counters (`mouse_clicks`, `keyboard_strokes`)
- `is_active` boolean, `idle_time_seconds`
- Optional `metadata` JSONB

Feeds daily aggregation for top applications/websites and productivity scores.

### `screenshots`
Metadata for each uploaded screenshot and generated thumbnail.

Fields include `screenshot_url`, `thumbnail_url`, `file_size_kb`, `active_window_title`, `active_application`, `screen_resolution`, `blur_applied`, `is_productive`, `category`.

### `lunch_breaks`
Start/end timestamps (with optional geo JSON) tied to an attendance record. Guarantees only one open break per attendance via query constraints in `activityService.startLunchBreak`.

### `productivity_summary`
Nightly aggregates (one row per user/date):
- Totals (`total_tracked_time`, `productive_time`, `unproductive_time`)
- JSON blobs `top_applications`, `top_websites`
- Input sums (`total_mouse_clicks`, `total_keyboard_strokes`)
- `productivity_score` (percentage of active time)

Upserted by `jobs/dailyAggregation.js`.

### `system_settings`
Arbitrary key/value store for runtime configuration (`screenshot_interval`, `idle_threshold`, `working_hours`, `max_break_duration`). Supports `UPSERT` with `updated_by` FK to `users`.

---

## Background Job: Daily Aggregation

* Schedule: `cron.schedule('0 0 * * *')` in `src/index.js`.
* Workflow per attendance record from yesterday:
  1. Summarize active/idle seconds from `activity_logs`.
  2. Count screenshots (`screenshots` table).
  3. Aggregate top apps + websites & input counts from `user_activity_tracking`.
  4. Compute `productivity_score = productive_time / total_tracked_time`.
  5. Upsert into `productivity_summary`.

Failures are logged via the custom logger; the server keeps running but you should monitor `logs/app.log`.

---

## API Conventions

* **Base URL**: `/` (info) and `/health` (heartbeat) do not require auth. Everything else lives under `/api`.
* **Auth header**: `Authorization: Bearer <JWT>`.
* **Success response**:
  ```json
  { "success": true, "data": { ... }, "message": "optional" }
  ```
* **Error response**:
  ```json
  { "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }
  ```
* **Validation**: Input validators (`utils/validators.js`) guard all user-provided payloads. Validation errors return `VALIDATION_ERROR`.
* **Roles**: `authorizeRoles('admin')` restricts user, report export, and settings mutation routes.

---

## Endpoint Reference

All endpoints reside under `src/routes`. Each row notes preconditions and side effects derived from the controller/service logic.

### Utility

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/` | none | Returns API metadata plus route map (`src/index.js`). |
| GET | `/health` | none | Simple health probe with current timestamp. |

### Authentication (`routes/auth.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | none | Creates a new user (`authController.register`). Hashes password, enforces unique email/employee_id. |
| POST | `/api/auth/login` | none | Issues JWT (`authController.login`). Rate-limited; checks `status === 'active'`. |
| POST | `/api/auth/logout` | Bearer | Stateless logout (purely client-side token discard, logged for auditing). |
| POST | `/api/auth/refresh-token` | Bearer | Mints a fresh JWT using current `req.user` payload. |
| GET | `/api/auth/me` | Bearer | Fetches the authenticated user's profile from DB. |

### Attendance (`routes/attendance.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/attendance/check-in` | Bearer | Creates or reopens today's `attendance_record`. Stores IP/location, starts an `activity_logs` row (`attendanceService.checkIn`). Rejects if already checked in and not checked out. |
| POST | `/api/attendance/check-out` | Bearer | Finalizes today's attendance: closes open activities/breaks, computes totals, clears Redis cache (`attendanceService.checkOut`). |
| GET | `/api/attendance/status` | Bearer | Returns booleans (`isCheckedIn`, `isCheckedOut`) plus today's attendance snapshot (with live totals). |
| GET | `/api/attendance/today` | Bearer | Full attendance row for today; 404 if none. |
| GET | `/api/attendance/history?start_date&end_date&user_id` | Bearer | Date-filtered history for current user. Admins may supply `user_id`. |
| PUT | `/api/attendance/:id/notes` | Bearer | Update free-form notes. Employees can only edit their own records; admins can edit any. |

**Checkout math**:
```text
total_work_duration = checkout - checkin
total_active_duration = SUM(activity_logs.active)
total_idle_duration = SUM(activity_logs.idle)
total_break_duration = SUM(lunch_breaks.duration)
```

### Activity Tracking (`routes/activity.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/activity/heartbeat` | Bearer | Primary activity ingestion point. Validates payload, ensures user is checked in, writes to `user_activity_tracking`, transitions between `active`/`idle` based on 5-minute threshold, caches last state in Redis. |
| POST | `/api/activity/log` | Bearer | Alias of `heartbeat` for manual logging (returns 201). |
| GET | `/api/activity/current` | Bearer | Latest open `activity_logs` row for today (null if none). |
| GET | `/api/activity/history?date` | Bearer | All `activity_logs` for a day (defaults to today). |

### Lunch Breaks (`routes/lunchBreak.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/lunch-break/start` | Bearer | Ends any open `activity_logs`, inserts `lunch_break` row, starts `activity_logs` entry of type `lunch_break`. Rejects if break already active or user not checked in. |
| POST | `/api/lunch-break/end` | Bearer | Sets `break_end_time`, duration, closing `activity_logs` entry and resumes `active` log. |
| GET | `/api/lunch-break/current` | Bearer | Returns active lunch break row (if any) for today. |

### Screenshot Management (`routes/screenshots.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| POST | `/api/screenshots/upload` | Bearer + multipart | Accepts `screenshot` file + optional metadata. Ensures user checked in, writes file + thumbnail, stores metadata row. Enforces MIME + size restrictions. Cleans up files on error. |
| GET | `/api/screenshots/list?date&user_id` | Bearer | Lists screenshots for given date (default: today). Admins can inspect other users by passing `user_id`. |
| GET | `/api/screenshots/:id` | Bearer | Returns screenshot metadata; non-admins restricted to their own. |
| DELETE | `/api/screenshots/:id` | Bearer | Deletes file(s) from disk and DB row. |

File layout example:
```
uploads/
  screenshots/
    {user_uuid}/
      2025-11-25/
        screenshot_1732512345000.png
        thumb_screenshot_1732512345000.png
```

### Reports (`routes/reports.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/reports/daily?date&user_id` | Bearer | Combines attendance row, grouped activity durations, screenshot count, and top applications for the specified day. Admins can override `user_id`. |
| GET | `/api/reports/weekly?start_date&user_id` | Bearer | Returns attendance records + totals spanning `start_date → today`. |
| GET | `/api/reports/monthly?month&year&user_id` | Bearer | Monthly rollup including `productivity_summary` rows and present/absent counts. |
| GET | `/api/reports/productivity-summary?period&user_id` | Bearer | Wraps `productivity_summary` rows over `week` or `month` window. |
| GET | `/api/reports/team-overview?date` | Bearer + admin | Snapshot of all active employees with today's attendance stats and aggregate totals. |
| GET | `/api/reports/export` | Bearer + admin | Placeholder endpoint (`reportController.exportReport`) returns “coming soon”. |

### User Management (`routes/users.js`, admin only)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/users` | List all users with basic profile fields. |
| POST | `/api/users` | Admin-created user (same validation as self-register). Password is hashed server-side. |
| GET | `/api/users/:id` | Fetch specific user. |
| PUT | `/api/users/:id` | Partial updates to `name`, `role`, `status`, `profile_picture_url`. Automatically stamps `updated_at`. |
| DELETE | `/api/users/:id` | Hard delete (ON DELETE CASCADE cleans dependent rows). |
| GET | `/api/users/:id/attendance-summary` | Returns aggregate totals + 10 most recent attendance records. |

### Settings (`routes/settings.js`)

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/api/settings` | Bearer | Dumps all key/value pairs from `system_settings` as a JSON map. |
| PUT | `/api/settings/:key` | Bearer + admin | Upserts a specific setting; body must include `value` (stored as JSON) and optional `description`. |

---

## Request / Response Examples

**Check-in**
```http
POST /api/attendance/check-in
Authorization: Bearer <token>
Content-Type: application/json

{
  "location": { "latitude": 40.71, "longitude": -74.00, "city": "NYC" }
}
```
Success → `201` with new/updated `attendance_record`.

**Heartbeat Payload**
```json
{
  "is_active": true,
  "active_window": "VS Code - dashboard.jsx",
  "active_application": "Visual Studio Code",
  "url": null,
  "mouse_clicks": 14,
  "keyboard_strokes": 110
}
```

**Screenshot Upload (multipart form fields)**
```
file field name: screenshot
text fields: active_window_title, active_application, screen_resolution
```

---

## Supporting Utilities

* `middleware/errorHandler.js`: Maps common Postgres codes (duplicate entry, FK violations) and JWT issues to friendly responses.
* `utils/helpers.js`: Common helpers (response builders, duration math, IP extraction).
* `utils/configValidation.js`: Ensures critical env vars exist before server boot.
* `utils/setup.js`: One-shot bootstrap to provision DB, run migrations, seed data.
* `logs/app.log`: Rolling log file created automatically; useful when running as a service.

---

## Manual Testing Workflow

1. Run `npm run setup` then `npm start`.
2. Open `Backend/test.http` with VS Code’s REST Client or paste requests into Postman.
3. Login using seeded credentials and copy the JWT into `@token`.
4. Exercise endpoints in this order: check-in → heartbeat/log → lunch break start/end → screenshot upload → check-out → fetch reports.

This flow covers every major code path (auth, validations, Redis caching, file uploads, report aggregation) and mirrors how the UI drives the backend.

---

## Troubleshooting Tips

* **Database errors (`23505`, `23503`)**: Returned as `DUPLICATE_ENTRY` or `FOREIGN_KEY_VIOLATION`; inspect payloads for conflicting data.
* **Redis unavailable**: Startup logs “Starting server without Redis caching”; functionality still works, only live activity snapshots become pure DB reads.
* **Screenshot upload fails**: Check `MAX_FILE_SIZE`, MIME type, and ensure `UPLOAD_DIR` is writable. Temporary files are removed on failure, so repeated attempts are safe.
* **JWT issues**: Ensure `JWT_SECRET` is customized; the app intentionally exits if the placeholder secret is detected.

---

Need more examples or flow charts? Check `Backend/README.md` for a shorter overview, then refer back here for deep technical details.

