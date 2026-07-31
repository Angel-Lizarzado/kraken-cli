const { processRescueFolder, applyDietMode, extractMassiveNative, cancelMassiveExtraction } = require('../../services/rescuesorter/sorter');

function registerRescueSorterHandlers(ipcMain, mainWindow) {
  const onLog = (message, type = 'info') => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('rescuesorter:progress', { message, type });
    }
  };

  // Handler original: organización de backups Raw (selecciona carpeta db/)
  ipcMain.handle('rescuesorter:process', async (event, args) => {
    const { sourcePath } = args;
    try {
      const result = await processRescueFolder(sourcePath, onLog);
      return { success: true, organizedCount: result.organizedCount };
    } catch (err) {
      console.error('[RescueSorter IPC] Error processing folder:', err);
      return { success: false, error: err.message };
    }
  });

  // Handler nuevo: Modo Diet Ultra-Lite
  // Recibe la ruta raíz del cloud y (opcionalmente) la ruta de la carpeta db/
  ipcMain.handle('rescuesorter:diet-mode', async (event, args) => {
    const { cloudPath, dbFolderPath } = args;
    try {
      const result = await applyDietMode(cloudPath, dbFolderPath || null, onLog);
      return { success: true, processed: result.processed, skipped: result.skipped };
    } catch (err) {
      console.error('[RescueSorter IPC] Error in diet mode:', err);
      return { success: false, error: err.message };
    }
  });

  // Handler para extracción masiva de tar
  ipcMain.handle('rescuesorter:extract-massive-tar', async (event, args) => {
    const { tarPath, destDir } = args;
    try {
      const result = await extractMassiveNative(tarPath, destDir, onLog);
      return result;
    } catch (err) {
      console.error('[RescueSorter IPC] Error in massive extract:', err);
      return { success: false, error: err.message };
    }
  });

  // Handler para cancelar extracción masiva
  ipcMain.handle('rescuesorter:cancel-massive-tar', async () => {
    cancelMassiveExtraction();
    return { success: true };
  });
}

module.exports = { registerRescueSorterHandlers };
