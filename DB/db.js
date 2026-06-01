const path = require('path')
const fs = require('fs')

// Try better-sqlite3; fall back to a simple JSON store if compilation failed
// (common on Windows without Visual Studio Build Tools).
let sqliteDb = null
let useJsonFallback = false

try {
  const Database = require('better-sqlite3')
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'library.db')
  const DB_DIR = path.dirname(DB_PATH)
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

  sqliteDb = new Database(DB_PATH)
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS library_paths (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `)
} catch (err) {
  console.warn('[db] better-sqlite3 unavailable, using JSON fallback:', err.message)
  useJsonFallback = true
}

if (useJsonFallback) {
  const jsonDb = require('./db-json-fallback')
  module.exports = jsonDb
} else {
  module.exports = {
    addPath(folderPath) {
      return sqliteDb.prepare('INSERT OR IGNORE INTO library_paths (path) VALUES (?)').run(folderPath)
    },
    getAllPaths() {
      return sqliteDb.prepare('SELECT path FROM library_paths ORDER BY added_at').all().map(r => r.path)
    },
    clearAll() {
      sqliteDb.prepare('DELETE FROM library_paths').run()
    },
    close() {
      sqliteDb.close()
    }
  }
}
