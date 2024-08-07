"use strict";
import { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, Menu } from 'electron';
import settings from 'electron-settings';
import path from 'path';

let mediaWindow = null;
let powerSaveBlockerId = null;
let windowBounds;
// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let win = null;
let ipcInitPromise = null;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('enable-experimental-web-platform-features', 'true');
Menu.setApplicationMenu(null)

const padStart = (num, targetLength, padString) => {
  const numStr = num.toString();
  let paddingNeeded = targetLength - numStr.length;
  let padding = '';

  while (paddingNeeded > 0) {
    padding += padString;
    paddingNeeded--;
  }

  return padding + numStr;
}

const toHHMMSS = (secs) => {
  return `${padStart((secs / 3600) | 0, 2, '0')}:${padStart(((secs % 3600) / 60) | 0, 2, '0')}:${padStart((secs % 60) | 0, 2, '0')}:${padStart(((secs * 1000) % 1000) | 0, 3, '0')}`;
};

function debounce(func, delay) {
  let timeoutId = null;
  const boundFunc = func.bind(this);
  return (...args) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => boundFunc(...args), delay);
  };
}

async function createWindow() {
  windowBounds = await windowBounds;
  ipcMain.on('set-mode', (event, arg) => {
    settings.set('operating-mode', arg)
      .catch(error => {
        console.error('Error saving window bounds:', error);
      });
  });

  ipcMain.handle('get-setting', async (event, setting) => {
    return settings.get(setting);
  });

  win = new BrowserWindow({
    width: windowBounds ? windowBounds.width : 1068,
    height: windowBounds ? windowBounds.height : 660,
    minWidth: 1096,
    minHeight: 681,
    webPreferences: {
      nodeIntegration: true,
      userGesture: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      preload: path.join(app.getAppPath(), 'app_preload.mjs')
    }
  })
  win.setAspectRatio(1.618);
  win.loadFile('index.html');

  win.webContents.on('did-finish-load', async () => {
    const saveWindowBounds = debounce(() => {
      settings.set('windowBounds', win.getBounds())
        .catch(error => {
          console.error('Error saving window bounds:', error);
        });
    }, 300);

    win.on('resize', saveWindowBounds);
  });

  // Open the DevTools.
  //win.webContents.openDevTools()

  // Emitted when the window is closed.
  win.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
    win = null;
    app.quit();

  });
  await ipcInitPromise;
}

function disablePowerSave() {
  if (powerSaveBlockerId === null) {
    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    console.log('Power Save Blocker started:', powerSaveBlockerId);
  } else {
    console.log('Power Save Blocker is already active:', powerSaveBlockerId);
  }
}

function enablePowersave() {
  if (powerSaveBlockerId !== null) {
    powerSaveBlocker.stop(powerSaveBlockerId);
    console.log('Power Save Blocker stopped:', powerSaveBlockerId);
    powerSaveBlockerId = null;
  } else {
    console.log('No active Power Save Blocker to stop.');
  }
}


async function initializeIPC() {
  ipcMain.handle('get-all-displays', () => {
    return screen.getAllDisplays();
  });

  ipcMain.handle('create-media-window', (event, windowOptions) => {
    mediaWindow = new BrowserWindow(windowOptions);
    mediaWindow.loadFile("media.html");
    mediaWindow.on('closed', () => {
      if (win)
        win.webContents.send('media-window-closed', mediaWindow.id);
    });
    return mediaWindow.id;
  });

  ipcMain.on('disable-powersave', () => {
    disablePowerSave();
  });

  ipcMain.on('enable-powersave', () => {
    enablePowersave();
  });

  ipcMain.on('vlcl', (event, v, id) => {
    if (mediaWindow != null && !mediaWindow.isDestroyed()) {
      mediaWindow.send('vlcl', v);
    }
  });

  ipcMain.on('timeGoto-message', (event, arg) => {
    if (mediaWindow != null && !mediaWindow.isDestroyed()) {
      mediaWindow.send('timeGoto-message', arg);
    }
  });

  ipcMain.on('play-ctl', (event, cmd, id) => {
    if (mediaWindow != null && !mediaWindow.isDestroyed()) {
      mediaWindow.send('play-ctl', cmd);
    }
  });

  ipcMain.handle('get-media-current-time', async () => {
    if (mediaWindow != null && !mediaWindow.isDestroyed()) {
      return await mediaWindow.webContents.executeJavaScript('document.querySelector("video").currentTime');
    }
  });

  ipcMain.on('close-media-window', (event, id) => {
    if (mediaWindow != null && !mediaWindow.isDestroyed()) {
      mediaWindow.hide();
      mediaWindow.close();
    }
  });

  ipcMain.on('timeRemaining-message', (event, arg) => {
    if (win) {
      win.webContents.send('timeRemaining-message', [toHHMMSS(arg[0] - arg[1]), arg[0], arg[1], arg[2]]);
    }
  });

  ipcMain.on('mediasession-pause', () => {
    win.webContents.send('mediasession-pause');
  });

  ipcMain.on('mediasession-play', () => {
    win.webContents.send('mediasession-play');
  });

  ipcMain.on('playback-state-change', (event, playbackState) => {
    if (win) {
      win.webContents.send('update-playback-state', playbackState);
    }
  });

}

app.on('will-finish-launching', async () => {
  ipcInitPromise = initializeIPC();
});

app.on('web-contents-created', (event, contents) => {
  contents.on('will-navigate', (event) => {
    event.preventDefault();
  });
});

windowBounds = settings.get('windowBounds');


app.whenReady().then(() => {
  createWindow();
});
// Quit when all windows are closed.
app.on('window-all-closed', () => {
  // On macOS it is common for applications and their menu bar
  // to stay active until the user quits explicitly with Cmd + Q
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  // On macOS it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (win === null) {
    createWindow()
  }
})