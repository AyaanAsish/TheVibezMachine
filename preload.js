const { contextBridge, ipcRenderer } = require('electron')


function initDatabase() {
  const db = new sqlite3.Database(':memory:', (err) => {
    if (err) {
      console.error("Error opening database", err.message);
      return;
    }
    console.log('Connected to the database.');
  });

  // Example: Create a table
  db.run(`CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)`, (err) => {
    if (err) {
      console.error("Error creating table", err.message);
      return;
    }
    console.log('Table created successfully.');
  });

  // Function to insert a new item
  function insertItem(name) {
    db.run(`INSERT INTO items (name) VALUES (?)`, [name], (err) => {
      if (err) {
        console.error("Error inserting row", err.message);
        return;
      }
      console.log('Row inserted successfully.');
    });
  }

  // Function to query the database
  function queryItems(callback) {
    db.all(`SELECT id, name FROM items`, [], (err, rows) => {
      if (err) {
        console.error("Error running query", err.message);
        return;
      }
      callback(rows);
    });
  }

contextBridge.exposeInMainWorld('electronAPI', {
  openFile: () => ipcRenderer.invoke('open-folder')
})
