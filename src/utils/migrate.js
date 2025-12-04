const { Pool } = require('pg');
require('dotenv').config();

const ensureDatabaseExists = require('./ensureDatabase');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const migration = `
-- Drop existing tables if they exist (in correct order due to foreign keys)
DROP TABLE IF EXISTS productivity_summary CASCADE;
DROP TABLE IF EXISTS screenshots CASCADE;
DROP TABLE IF EXISTS user_activity_tracking CASCADE;
DROP TABLE IF EXISTS activity_logs CASCADE;
DROP TABLE IF EXISTS lunch_breaks CASCADE;
DROP TABLE IF EXISTS attendance_records CASCADE;
DROP TABLE IF EXISTS system_settings CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Create users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    employee_id VARCHAR(50) UNIQUE NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('employee', 'admin', 'hr')),
    profile_picture_url TEXT,
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'terminated')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create attendance_records table
CREATE TABLE attendance_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    check_in_time TIMESTAMP NOT NULL,
    check_out_time TIMESTAMP,
    total_work_duration INTEGER DEFAULT 0,
    total_active_duration INTEGER DEFAULT 0,
    total_idle_duration INTEGER DEFAULT 0,
    total_break_duration INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present', 'absent', 'half_day', 'on_leave')),
    check_in_ip VARCHAR(45),
    check_out_ip VARCHAR(45),
    check_in_location JSONB,
    check_out_location JSONB,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_date UNIQUE(user_id, date)
);

-- Create activity_logs table
CREATE TABLE activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attendance_record_id UUID REFERENCES attendance_records(id) ON DELETE CASCADE,
    activity_type VARCHAR(20) NOT NULL CHECK (activity_type IN ('active', 'idle', 'lunch_break', 'meeting')),
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP,
    duration INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create user_activity_tracking table
CREATE TABLE user_activity_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attendance_record_id UUID REFERENCES attendance_records(id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL,
    active_window_title TEXT,
    active_application VARCHAR(255),
    url TEXT,
    mouse_clicks INTEGER DEFAULT 0,
    keyboard_strokes INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    idle_time_seconds INTEGER DEFAULT 0,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create screenshots table
CREATE TABLE screenshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attendance_record_id UUID REFERENCES attendance_records(id) ON DELETE CASCADE,
    timestamp TIMESTAMP NOT NULL,
    screenshot_url TEXT NOT NULL,
    thumbnail_url TEXT,
    file_size_kb INTEGER,
    active_window_title TEXT,
    active_application VARCHAR(255),
    screen_resolution VARCHAR(20),
    blur_applied BOOLEAN DEFAULT false,
    is_productive BOOLEAN,
    category VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create lunch_breaks table
CREATE TABLE lunch_breaks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attendance_record_id UUID NOT NULL REFERENCES attendance_records(id) ON DELETE CASCADE,
    break_start_time TIMESTAMP NOT NULL,
    break_end_time TIMESTAMP,
    duration INTEGER,
    start_location JSONB,
    end_location JSONB,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create productivity_summary table
CREATE TABLE productivity_summary (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date DATE NOT NULL,
    total_tracked_time INTEGER DEFAULT 0,
    productive_time INTEGER DEFAULT 0,
    unproductive_time INTEGER DEFAULT 0,
    neutral_time INTEGER DEFAULT 0,
    top_applications JSONB,
    top_websites JSONB,
    total_screenshots INTEGER DEFAULT 0,
    total_mouse_clicks INTEGER DEFAULT 0,
    total_keyboard_strokes INTEGER DEFAULT 0,
    productivity_score INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_user_date_summary UNIQUE(user_id, date)
);

-- Create system_settings table
CREATE TABLE system_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value JSONB NOT NULL,
    description TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better query performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_employee_id ON users(employee_id);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);

CREATE INDEX idx_attendance_user_id ON attendance_records(user_id);
CREATE INDEX idx_attendance_date ON attendance_records(date);
CREATE INDEX idx_attendance_user_date ON attendance_records(user_id, date);

CREATE INDEX idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_attendance_id ON activity_logs(attendance_record_id);
CREATE INDEX idx_activity_logs_start_time ON activity_logs(start_time);
CREATE INDEX idx_activity_logs_type ON activity_logs(activity_type);

CREATE INDEX idx_user_activity_user_id ON user_activity_tracking(user_id);
CREATE INDEX idx_user_activity_attendance_id ON user_activity_tracking(attendance_record_id);
CREATE INDEX idx_user_activity_timestamp ON user_activity_tracking(timestamp);

CREATE INDEX idx_screenshots_user_id ON screenshots(user_id);
CREATE INDEX idx_screenshots_attendance_id ON screenshots(attendance_record_id);
CREATE INDEX idx_screenshots_timestamp ON screenshots(timestamp);

CREATE INDEX idx_lunch_breaks_user_id ON lunch_breaks(user_id);
CREATE INDEX idx_lunch_breaks_attendance_id ON lunch_breaks(attendance_record_id);

CREATE INDEX idx_productivity_user_id ON productivity_summary(user_id);
CREATE INDEX idx_productivity_date ON productivity_summary(date);

CREATE INDEX idx_settings_key ON system_settings(setting_key);
`;

async function runMigration() {
  await ensureDatabaseExists(process.env.DATABASE_URL);
  const client = await pool.connect();
  try {
    console.log('Starting database migration...');
    await client.query(migration);
    console.log('✅ Database migration completed successfully!');
    console.log('✅ All tables and indexes created.');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runMigration();
}

module.exports = runMigration;
