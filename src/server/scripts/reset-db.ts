import { loadConfig } from "../config.js";
import { openDatabase, resetDatabase } from "../db/database.js";

const config = loadConfig();
const database = openDatabase(config.databasePath);
resetDatabase(database);
database.close();

console.log(`Canonical demo data restored in ${config.databasePath}.`);
