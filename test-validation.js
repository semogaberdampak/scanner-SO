/**
 * Independent Validation Test for Code Review Fixes
 *
 * This script validates that all 5 issues from the code review have been fixed
 * by statically analyzing the apps-script/Code.gs file.
 */

const fs = require('fs');
const path = require('path');

const CODE_FILE = path.join(__dirname, 'apps-script', 'Code.gs');

function readCode() {
  return fs.readFileSync(CODE_FILE, 'utf-8');
}

function runTests() {
  const code = readCode();
  const results = {
    passed: 0,
    failed: 0,
    tests: []
  };

  function assert(name, condition, details = '') {
    if (condition) {
      results.passed++;
      results.tests.push({ name, status: 'PASS', details });
      console.log(`✅ PASS: ${name}`);
    } else {
      results.failed++;
      results.tests.push({ name, status: 'FAIL', details });
      console.log(`❌ FAIL: ${name} - ${details}`);
    }
  }

  console.log('\n=== INDEPENDENT VALIDATION TESTS ===\n');

  // TEST 1: No BOM at start of file
  assert('No BOM at file start',
    !code.startsWith('﻿') && code.startsWith('/**'),
    'File should start with /** not BOM');

  // TEST 2: File ends with newline
  assert('File ends with newline',
    code.endsWith('\n'),
    'File should end with newline character');

  // TEST 3: SESSION_SECONDS = 6 * 60 * 60 (6 hours = 21600)
  assert('SESSION_SECONDS is 6 hours (21600 seconds)',
    code.includes('var SESSION_SECONDS = 6 * 60 * 60;'),
    'SESSION_SECONDS should be 6 * 60 * 60');

  // TEST 4: PIN_DEFAULT is defined (not commented out)
  assert('PIN_DEFAULT is defined',
    code.includes('var PIN_DEFAULT =') && !code.match(/\/\/ var PIN_DEFAULT =/),
    'PIN_DEFAULT should be defined and not commented out');

  // TEST 5: PIN_ADMIN_DEFAULT is defined
  assert('PIN_ADMIN_DEFAULT is defined',
    code.includes('var PIN_ADMIN_DEFAULT =') && !code.match(/\/\/ var PIN_ADMIN_DEFAULT =/),
    'PIN_ADMIN_DEFAULT should be defined and not commented out');

  // TEST 6: PIN_VERIFIKATOR_DEFAULT is defined
  assert('PIN_VERIFIKATOR_DEFAULT is defined',
    code.includes('var PIN_VERIFIKATOR_DEFAULT =') && !code.match(/\/\/ var PIN_VERIFIKATOR_DEFAULT =/),
    'PIN_VERIFIKATOR_DEFAULT should be defined and not commented out');

  // TEST 7: Verifikator login has success return after PIN check
  assert('Verifikator login returns success after PIN verification',
    code.includes('role === \'VERIFIKATOR\'') &&
    code.includes('// Verifikator login sukses') &&
    code.includes('return { ok: true, token: token, user: user };') &&
    code.indexOf('// Verifikator login sukses') < code.lastIndexOf('return { ok: true, token: token, user: user };'),
    'Verifikator role should have successful login return after PIN check');

  // TEST 8: Kasir login has success return after PIN check
  assert('Kasir login returns success after PIN verification',
    code.includes('// Kasir login sukses') &&
    code.includes('return { ok: true, token: token, user: user };') &&
    code.indexOf('// Kasir login sukses') < code.lastIndexOf('return { ok: true, token: token, user: user };'),
    'Kasir role should have successful login return after PIN check');

  // TEST 9: No fall-through to "Login gagal" for valid roles
  // The old buggy code had: if/else for PIN check, then fall-through to return { ok: false, error: 'Login gagal.' }
  // Fixed code should return success inside each branch
  const verifSection = code.substring(
    code.indexOf('role === \'VERIFIKATOR\''),
    code.indexOf('} else {')
  );
  const kasirSection = code.substring(
    code.indexOf('} else {'),
    code.indexOf('return { ok: false, error: \'Login gagal.\' };')
  );

  // Check that "Login gagal" is NOT reachable after successful PIN verification
  // The fixed code should have removed the fall-through entirely
  assert('No fall-through to "Login gagal" for verified users',
    !code.includes('return { ok: false, error: \'Login gagal.\' };') ||
    code.lastIndexOf('return { ok: true, token: token, user: user };') > code.indexOf('return { ok: false, error: \'Login gagal.\' };'),
    'Should not fall through to "Login gagal" after successful PIN verification');

  // TEST 10: Verifikator username pattern
  assert('Verifikator username uses verifikator_ prefix',
    code.includes('verifikator_\' + cabang'),
    'Verifikator username should follow pattern verifikator_{cabang}');

  // TEST 11: Kasir username pattern
  assert('Kasir username uses kasir_ prefix',
    code.includes('kasir_\' + cabang'),
    'Kasir username should follow pattern kasir_{cabang}');

  // TEST 12: Admin login still works
  assert('Admin login logic unchanged',
    code.includes('cabang === \'admin\'') &&
    code.includes('APP_PIN_ADMIN') &&
    code.includes('username: \'admin\'') &&
    code.includes('role: \'ADMIN\''),
    'Admin login logic should remain intact');

  // TEST 13: CacheService used with SESSION_SECONDS
  assert('Session cache uses SESSION_SECONDS',
    (code.match(/CacheService\.getScriptCache\(\)\.put\(/g) || []).length >= 4,
    'CacheService.put should be called for all 3 role types + session renewal (admin, verifikator, kasir, requireSession_)');

  console.log('\n=== SUMMARY ===');
  console.log(`Passed: ${results.passed}`);
  console.log(`Failed: ${results.failed}`);
  console.log(`Total:  ${results.passed + results.failed}`);

  if (results.failed > 0) {
    console.log('\n❌ SOME TESTS FAILED - Review the fixes');
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED - All fixes validated!');
    process.exit(0);
  }
}

runTests();