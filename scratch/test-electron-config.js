const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.whenReady().then(() => {
  const exeDir = process.execPath ? path.dirname(process.execPath) : process.cwd();
  const configPath = path.join(path.resolve(exeDir, '..'), 'config.json');
  console.log('[DIAGNOSTIC] process.execPath:', process.execPath);
  console.log('[DIAGNOSTIC] exeDir:', exeDir);
  console.log('[DIAGNOSTIC] configPath resolved:', configPath);
  console.log('[DIAGNOSTIC] configPath exists:', fs.existsSync(configPath));
  app.quit();
});
