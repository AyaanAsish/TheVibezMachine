const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'library.db')
const DB_DIR = path.dirname(DB_PATH)
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)

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