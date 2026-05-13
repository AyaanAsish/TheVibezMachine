const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_DIR = path.join(__dirname, 'DB')
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR)

const db = new Database(path.join(DB_DIR, 'library.db'))

db.exec(`
  CREATE TABLE IF NOT EXISTS library_paths (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    added_at TEXT DEFAULT (datetime('now'))
  )
`)

module.exports = {
  addPath(folderPath) {
    return db.prepare('INSERT OR IGNORE INTO library_paths (path) VALUES (?)').run(folderPath)
  },
  getAllPaths() {
    return db.prepare('SELECT path FROM library_paths ORDER BY added_at').all().map(r => r.path)
  },
  clearAll() {
    db.prepare('DELETE FROM library_paths').run()
  },
  close() {
    db.close()
  }
}
