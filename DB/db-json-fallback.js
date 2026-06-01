const path = require('path')
const fs = require('fs')

// Simple JSON-file fallback for platforms where better-sqlite3 isn't available
// (e.g., Windows without build tools). Stores library folder paths.

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'library.json')
const DB_DIR = path.dirname(DB_PATH)
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })

let data = { paths: [] }

try {
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, 'utf8')
    data = JSON.parse(raw)
    if (!Array.isArray(data.paths)) data.paths = []
  }
} catch (_) {
  data = { paths: [] }
}

function save() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2))
  } catch (e) {
    console.warn('[json-db] Failed to write DB:', e.message)
  }
}

module.exports = {
  addPath(folderPath) {
    if (!data.paths.includes(folderPath)) {
      data.paths.push(folderPath)
      save()
    }
    return { changes: 1 }
  },
  getAllPaths() {
    return data.paths
  },
  clearAll() {
    data.paths = []
    save()
  },
  close() {
    // no-op for JSON file
  }
}
