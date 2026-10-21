import { config } from '../config/index.js';
import { createDatabase, migrateDown, migrateUp, migrationStatus } from './migrator.js';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'create': {
      const name = await createDatabase();
      console.log(`Database "${name}" is ready.`);
      break;
    }
    case 'up':
      console.log(`Running migrations on "${config.db.database}"...`);
      await createDatabase();
      await migrateUp();
      break;
    case 'down': {
      const steps = Number.parseInt(process.argv[3] || '1', 10);
      console.log(`Reverting ${steps} migration(s) on "${config.db.database}"...`);
      await migrateDown({ steps });
      break;
    }
    case 'status': {
      const rows = await migrationStatus();
      for (const row of rows) console.log(`  ${row.applied ? '✔' : '✗'} ${row.file}`);
      break;
    }
    default:
      console.log('Usage: node src/db/cli.js <create|up|down [steps]|status>');
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
