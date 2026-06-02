const path = require('path');
const fs = require('fs');

const exeDir = process.cwd(); // or process.execPath
const configPath = path.join(path.resolve(exeDir), 'config', 'config.json');

console.log('process.cwd():', process.cwd());
console.log('configPath exists:', fs.existsSync(configPath));
console.log('configPath:', configPath);
