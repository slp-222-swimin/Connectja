import { app, BrowserWindow, shell, dialog } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import isDev from 'electron-is-dev'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function createMainWindow() {
  const iconPath = path.join(__dirname, '..', 'logo.ico')
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    backgroundColor: '#111111',
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (isDev) {
    win.loadURL('http://127.0.0.1:5173')
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    const indexPath = path.join(__dirname, '..', 'dist', 'index.html')
    void win.loadFile(indexPath)
  }

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    dialog.showErrorBox(
      'Connectja Load Error',
      `Failed to load renderer.\nCode: ${errorCode}\nReason: ${errorDescription}\nURL: ${validatedURL}`
    )
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    dialog.showErrorBox(
      'Connectja Renderer Crashed',
      `Reason: ${details.reason}\nExit code: ${details.exitCode}`
    )
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
