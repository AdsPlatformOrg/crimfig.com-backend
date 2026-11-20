const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateMigrationRegistry } = require('./validate-migration-registry.cjs');

test('registry rejects an omitted SQL file and a missing registered file', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-registry-'));
  try {
    fs.mkdirSync(path.join(folder, 'meta'));
    fs.writeFileSync(path.join(folder, '0001_fixture.sql'), 'select 1;');
    const journal = path.join(folder, 'meta/_journal.json');
    fs.writeFileSync(journal, JSON.stringify({ entries: [] }));
    assert.throws(() => validateMigrationRegistry(folder), /Unregistered SQL/);
    fs.writeFileSync(journal, JSON.stringify({ entries: [{ idx: 0, tag: '0002_missing', when: 1 }] }));
    assert.throws(() => validateMigrationRegistry(folder), /file missing/);
    fs.writeFileSync(journal, JSON.stringify({ entries: [{ idx: 0, tag: '0001_fixture', when: 1 }] }));
    assert.deepEqual(validateMigrationRegistry(folder), { migrations: 1 });
    fs.writeFileSync(journal, JSON.stringify({ entries: [
      { idx: 0, tag: '0001_fixture', when: 1 }, { idx: 1, tag: '0001_fixture', when: 2 },
    ] }));
    assert.throws(() => validateMigrationRegistry(folder), /Duplicate/);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
