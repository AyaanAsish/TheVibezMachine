const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// 1. Ensure the DB directory exists
const DB_DIR = path.join(__dirname, 'DB');
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR);
}

// 2. Initialize the precompiled SQLite3 engine pointing to the DB folder
const dbPath = path.join(DB_DIR, 'library.db');
const db = new sqlite3.Database(dbPath);

// 3. Initialize the database table structure
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS library_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `);
});

// 4. Export the application helper methods matching your query syntax
module.exports = {
  addPath(folderPath) {
    db.run('INSERT OR IGNORE INTO library_paths (path) VALUES (?)', [folderPath]);
  },
  
  getAllPaths() {
    return new Promise((resolve, reject) => {
      db.all('SELECT path FROM library_paths ORDER BY added_at', [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows.map(r => r.path));
      });
    });
  },
  
  clearAll() {
    db.run('DELETE FROM library_paths');
  },
  
  close() {
    db.close();
  }
};
