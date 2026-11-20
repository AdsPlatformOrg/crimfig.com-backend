const fs = require('node:fs');
const path = require('node:path');

function validateMigrationRegistry(folder) {
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
  const files = new Set(fs.readdirSync(folder).filter(file => file.endsWith('.sql')));
  const registered = new Set();
  let previous = -1;
  for (const [index, entry] of journal.entries.entries()) {
    const filename = entry.tag + '.sql';
    if (!/^[0-9]{4}_[a-z0-9_]+$/.test(entry.tag) || entry.idx !== index ||
        !Number.isSafeInteger(entry.when) || entry.when <= previous) {
      throw new Error('Invalid migration order or identity at index ' + index);
    }
    if (registered.has(filename)) throw new Error('Duplicate migration registration: ' + filename);
    if (!files.has(filename)) throw new Error('Registered migration file missing: ' + filename);
    registered.add(filename);
    previous = entry.when;
  }
  const missing = [...files].filter(file => !registered.has(file));
  if (missing.length) throw new Error('Unregistered SQL migrations: ' + missing.join(', '));
  return { migrations: registered.size };
}
module.exports = { validateMigrationRegistry };
if (require.main === module) {
  try {
    console.log(JSON.stringify(validateMigrationRegistry(process.argv[2] || path.resolve(__dirname, '../database/migrations'))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
