const ExcelJS = require('exceljs');
const pool = require('../config/database');
const { formatTime } = require('../utils/helpers');

// Visual style extracted from the company's existing hand-maintained attendance
// register template, reproduced here in code so it can be regenerated for any
// month/year (the source file has a fixed 31-day/July layout that can't just be
// re-filled for a shorter month).
const HEADER_DARK_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF95B3D7' } };
const HEADER_LIGHT_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8DB3E2' } };
const THIN_BORDER = {
  top: { style: 'thin' },
  bottom: { style: 'thin' },
  left: { style: 'thin' },
  right: { style: 'thin' },
};
const DAY_ABBREVIATIONS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function pad(n) {
  return String(n).padStart(2, '0');
}

async function generateMonthlyRegister(month, year) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const startDate = `${year}-${pad(month)}-01`;
  const endDate = `${year}-${pad(month)}-${pad(daysInMonth)}`;

  // Only role='employee' rows go into this register — admin/HR accounts are
  // intentionally excluded from the listed data, regardless of who is viewing it.
  const employeesResult = await pool.query(
    `SELECT id, name, employee_id FROM users
     WHERE role = 'employee' AND status = 'active'
     ORDER BY name ASC`
  );
  const employees = employeesResult.rows;

  const attendanceResult = await pool.query(
    `SELECT user_id, date, check_in_time, check_out_time
     FROM attendance_records
     WHERE user_id = ANY($1::uuid[]) AND date >= $2::date AND date <= $3::date`,
    [employees.map((e) => e.id), startDate, endDate]
  );

  // attendance[userId][dayOfMonth] = { check_in_time, check_out_time }
  const attendanceByUserAndDay = {};
  for (const row of attendanceResult.rows) {
    const day = new Date(row.date).getUTCDate(); // DATE columns carry no tz ambiguity
    if (!attendanceByUserAndDay[row.user_id]) attendanceByUserAndDay[row.user_id] = {};
    attendanceByUserAndDay[row.user_id][day] = row;
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Attendance');

  sheet.getColumn(1).width = 6; // SN
  sheet.getColumn(2).width = 22; // Emp. Name
  for (let day = 1; day <= daysInMonth; day++) {
    const inCol = 3 + (day - 1) * 2;
    sheet.getColumn(inCol).width = 9;
    sheet.getColumn(inCol + 1).width = 9;
  }

  sheet.getRow(1).height = 31.5;
  sheet.getRow(2).height = 16.5;
  sheet.getRow(3).height = 16.5;

  // Row 1: date headers, merged across each day's IN/OUT column pair
  // Row 2: day-of-week abbreviation, same merge pattern; B2:B3 = "Emp. Name"
  // Row 3: "SN" / "IN" / "OUT" column labels
  sheet.mergeCells(2, 2, 3, 2);
  const empNameHeader = sheet.getCell(2, 2);
  empNameHeader.value = 'Emp. Name';
  empNameHeader.font = { name: 'Calibri', size: 11, bold: true };
  empNameHeader.fill = HEADER_DARK_FILL;
  empNameHeader.alignment = { horizontal: 'center', vertical: 'middle' };
  empNameHeader.border = THIN_BORDER;

  const snHeader = sheet.getCell(3, 1);
  snHeader.value = 'SN';
  snHeader.font = { name: 'Arial', size: 11, bold: true };
  snHeader.fill = HEADER_DARK_FILL;
  snHeader.alignment = { horizontal: 'center', vertical: 'middle' };
  snHeader.border = THIN_BORDER;

  const a2 = sheet.getCell(2, 1);
  a2.fill = HEADER_DARK_FILL;
  a2.border = THIN_BORDER;

  for (let day = 1; day <= daysInMonth; day++) {
    const inCol = 3 + (day - 1) * 2;
    const outCol = inCol + 1;
    // Built via Date.UTC so the header date/day-of-week is correct regardless
    // of the timezone of the machine running this code (new Date(y, m, d) would
    // silently depend on the local system timezone instead).
    const date = new Date(Date.UTC(year, month - 1, day));

    sheet.mergeCells(1, inCol, 1, outCol);
    const dateCell = sheet.getCell(1, inCol);
    dateCell.value = date;
    dateCell.numFmt = 'mm-dd-yy';
    dateCell.font = { name: 'Calibri', size: 11, bold: true };
    dateCell.fill = HEADER_LIGHT_FILL;
    dateCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dateCell.border = THIN_BORDER;

    sheet.mergeCells(2, inCol, 2, outCol);
    const dayCell = sheet.getCell(2, inCol);
    dayCell.value = DAY_ABBREVIATIONS[date.getUTCDay()];
    dayCell.font = { name: 'Calibri', size: 11, bold: true };
    dayCell.fill = HEADER_LIGHT_FILL;
    dayCell.alignment = { horizontal: 'center', vertical: 'middle' };
    dayCell.border = THIN_BORDER;

    const inLabel = sheet.getCell(3, inCol);
    inLabel.value = 'IN';
    inLabel.font = { name: 'Calibri', size: 11, bold: true };
    inLabel.fill = HEADER_LIGHT_FILL;
    inLabel.alignment = { horizontal: 'center', vertical: 'middle' };
    inLabel.border = THIN_BORDER;

    const outLabel = sheet.getCell(3, outCol);
    outLabel.value = 'OUT';
    outLabel.font = { name: 'Calibri', size: 11, bold: true };
    outLabel.fill = HEADER_LIGHT_FILL;
    outLabel.alignment = { horizontal: 'center', vertical: 'middle' };
    outLabel.border = THIN_BORDER;
  }

  employees.forEach((employee, index) => {
    const rowNum = 4 + index;
    sheet.getRow(rowNum).height = 16.5;

    const snCell = sheet.getCell(rowNum, 1);
    snCell.value = index + 1;
    snCell.font = { name: 'Calibri', size: 11 };
    snCell.border = THIN_BORDER;

    const nameCell = sheet.getCell(rowNum, 2);
    nameCell.value = employee.name;
    nameCell.font = { name: 'Calibri', size: 10 };
    nameCell.alignment = { horizontal: 'center', vertical: 'middle' };
    nameCell.border = THIN_BORDER;

    const daily = attendanceByUserAndDay[employee.id] || {};
    for (let day = 1; day <= daysInMonth; day++) {
      const inCol = 3 + (day - 1) * 2;
      const outCol = inCol + 1;
      const record = daily[day];

      const inCell = sheet.getCell(rowNum, inCol);
      inCell.value = record ? formatTime(record.check_in_time) : '';
      inCell.font = { name: 'Calibri', size: 10 };
      inCell.alignment = { horizontal: 'center', vertical: 'middle' };
      inCell.border = THIN_BORDER;

      const outCell = sheet.getCell(rowNum, outCol);
      outCell.value = record ? formatTime(record.check_out_time) : '';
      outCell.font = { name: 'Calibri', size: 10 };
      outCell.alignment = { horizontal: 'center', vertical: 'middle' };
      outCell.border = THIN_BORDER;
    }
  });

  sheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 3 }];

  return workbook.xlsx.writeBuffer();
}

module.exports = { generateMonthlyRegister };
