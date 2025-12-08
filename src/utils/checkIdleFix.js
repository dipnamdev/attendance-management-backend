/**
 * Diagnostic script to check if the idle detection fix is deployed
 * 
 * This will show you the actual code running on the server
 */

const fs = require('fs');
const path = require('path');

console.log('=== Idle Detection Fix Diagnostic ===\n');

// Read the activityService.js file
const filePath = path.join(__dirname, '../services/activityService.js');
const content = fs.readFileSync(filePath, 'utf8');

// Check for the old buggy code
const hasBuggyCode = content.includes('|| !is_active');

// Check for the fixed code
const hasFixedCode = content.includes('Only occurs if time threshold exceeded');

console.log('File path:', filePath);
console.log('\nCode Analysis:');
console.log('- Has OLD buggy code (|| !is_active):', hasBuggyCode ? '❌ YES - NOT FIXED!' : '✅ No');
console.log('- Has FIXED code comment:', hasFixedCode ? '✅ YES - FIXED!' : '❌ No');

if (hasBuggyCode) {
    console.log('\n⚠️  WARNING: The old buggy code is still present!');
    console.log('The fix has NOT been deployed to this server.');
    console.log('\nYou need to:');
    console.log('1. git pull origin main');
    console.log('2. docker-compose restart backend');
} else if (hasFixedCode) {
    console.log('\n✅ SUCCESS: The fix is deployed!');
    console.log('Idle logs will only be created after 5+ minutes of inactivity.');
} else {
    console.log('\n❓ UNKNOWN: Cannot determine code status');
}

// Show the relevant code section
console.log('\n=== Current Code (lines around idle detection) ===');
const lines = content.split('\n');
const startIdx = lines.findIndex(l => l.includes('Case 1: Transition from Active to Idle'));
if (startIdx !== -1) {
    console.log(lines.slice(startIdx, startIdx + 15).join('\n'));
}
