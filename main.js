const { app, BrowserWindow, ipcMain, dialog, screen } = require("electron");
const fs = require("fs");
const path = require("path");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const win = new BrowserWindow({
    width: width,
    height: height,
    minWidth: 650,
    minHeight: 500,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

ipcMain.handle("open-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths.length) return null;

  const folderPath = result.filePaths[0];
  const files = fs.readdirSync(folderPath).map((f) => path.join(folderPath, f));
  return { folder: folderPath, files };
});

ipcMain.handle("scan-folder", async (event, folderPath) => {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    const audioExt = [".mp3", ".wav", ".flac", ".ogg", ".m4a"];
    const imageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp"];

    const folders = [];
    const audioFiles = [];

    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path: fullPath });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (audioExt.includes(ext)) {
          audioFiles.push({ name: entry.name, path: fullPath });
        }
      }
    }

    // Check for album cover
    let coverImage = null;
    for (const entry of entries) {
      const name = entry.name.toLowerCase();
      if (
        imageExt.includes(path.extname(name).toLowerCase()) &&
        (name === "cover.jpg" ||
          name === "cover.png" ||
          name === "folder.jpg" ||
          name === "folder.png" ||
          name === "album.jpg" ||
          name === "album.png")
      ) {
        coverImage = path.join(folderPath, entry.name);
        break;
      }
    }

    return { folderPath, folders, audioFiles, coverImage };
  } catch (err) {
    console.error("Error scanning folder:", err);
    return null;
  }
});

app.on("closed", () => {
  app.quit();
});
