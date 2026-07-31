const fs = require('fs');
const path = require('path');
const os = require('os');
const keytar = require('keytar');
const crypto = require('crypto');
const { safeStorage, app } = require('electron');

class ConfigManager {
  constructor() {
    const env = process.env.NODE_ENV || 'development';

    // ── Workspace Path: resolución dinámica ──
    // No se asigna en el constructor — se resuelve bajo demanda
    // para permitir cambios de workspaceRoot en electron-store
    this._workspaceRoot = null;
    this._resolved = false;

    // Ruta del config.json: un nivel arriba del ejecutable (padre de win-unpacked/)
    // para que survivinga independientemente del workspace
    const exeDir = process.execPath ? path.dirname(process.execPath) : process.cwd();
    this.configPath = path.join(path.resolve(exeDir, '..'), 'config.json');

    this.serviceName = 'clinmedia-ops';
    this.accountName = 'clinmedia-ops-config';
    this.config = null;
    this.masterKey = null;
    this.env = env;
  }

  // ── Resolución dinámica del workspace path ──
  // Prioridad: 1) env var > 2) electron-store > 3) fallback inteligente > 4) legacy
  _resolveWorkspacePath() {
    // 1) Variable de entorno — override absoluto
    const envPath = process.env.CLINMEDIA_OPS_PATH;
    if (envPath && typeof envPath === 'string' && envPath.trim()) {
      const resolved = path.resolve(envPath.trim());
      if (fs.existsSync(resolved)) {
        console.log(`[WORKSPACE] Resuelto por CLINMEDIA_OPS_PATH: ${resolved}`);
        return resolved;
      }
      console.warn(`[WORKSPACE] CLINMEDIA_OPS_PATH existe pero no se encuentra en disco, se usará: ${resolved}`);
      return resolved;
    }

    // 2) electron-store — configurable desde UI, persiste entre sesiones
    if (this.config?.workspaceRoot && typeof this.config.workspaceRoot === 'string' && this.config.workspaceRoot.trim()) {
      const resolved = path.resolve(this.config.workspaceRoot.trim());
      console.log(`[WORKSPACE] Resuelto por config.workspaceRoot: ${resolved}`);
      return resolved;
    }

    // 3) Fallback inteligente: detecta directorios conocidos
    const knownPaths = ['D:\\Centro de Control', 'C:\\Centro de Control'];
    for (const p of knownPaths) {
      if (fs.existsSync(p)) {
        console.log(`[WORKSPACE] Fallback inteligente: detectado en ${p}`);
        return p;
      }
    }

    // 4) Fallback al directorio PADRE del ejecutable (un nivel arriba del .exe)
    // En win-unpacked: .../clinmedia-ops/MyApp.exe → subir dos niveles → .../
    // Allí deben estar respaldos/ y config.json
    const exeDir = process.execPath ? path.dirname(process.execPath) : process.cwd();
    const parentDir = path.resolve(exeDir, '..');
    console.log(`[WORKSPACE] Fallback al directorio padre del ejecutable: ${parentDir}`);
    console.log(`[WORKSPACE] Los backups se guardarán en: ${path.join(parentDir, 'respaldos')}`);
    return parentDir;
  }

  /**
   * Obtiene la ruta raíz del workspace.
   * Resuelve bajo demanda y cachea el resultado en la sesión.
   * Llama a resolve() para refrescar si cambia workspaceRoot en config.
   */
  getWorkspacePath() {
    if (!this._resolved) {
      this._workspaceRoot = this._resolveWorkspacePath();
      this._resolved = true;
    }
    return this._workspaceRoot;
  }

  /**
   * Fuerza re-resolución del workspace path.
   * Útil cuando el usuario cambia workspaceRoot desde la UI.
   */
  refreshWorkspacePath() {
    this._resolved = false;
    return this.getWorkspacePath();
  }

  /**
   * Valida que un path esté DENTRO del workspace root (Anti-Path-Traversal).
   * Lanza Error si el path resuelto escapa del directorio raíz.
   * @param {string} targetPath — ruta a validar
   * @returns {string} — ruta resuelta y segura
   */
  assertPathInsideWorkspace(targetPath) {
    const root = path.resolve(this.getWorkspacePath());
    const resolved = path.resolve(root, targetPath);

    // Si el resolved NO empieza con root, es path traversal
    const normalizedRoot = root.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    const normalizedResolved = resolved.replace(/\\/g, '/');
    if (!normalizedResolved.startsWith(normalizedRoot)) {
      throw new Error(
        `[SEGURIDAD] Path traversal bloqueado: "${targetPath}" resuelve fuera del workspace "${root}"`
      );
    }
    return resolved;
  }

  /**
   * Verifica si el workspace actual es inválido (apunta a resources/ o app.asar).
   * @returns {boolean}
   */
  isWorkspacePathInvalid() {
    const ws = this.getWorkspacePath();
    if (!ws) return true;
    const lower = ws.toLowerCase();
    return lower.includes('resources') || lower.includes('app.asar');
  }

  /**
   * Retorna la ruta a la carpeta de respaldos.
   * Convención: workspaceRoot ES la carpeta de respaldos — no se agrega subfolder.
   */
  getRespaldosPath() {
    return this.getWorkspacePath();
  }

  /**
   * Retorna la ruta al directorio temporal para operaciones.
   */
  getTempDownloadPath() {
    const ws = this.getWorkspacePath();
    const tempPath = path.join(ws, 'temp');
    const fs = require('fs');
    if (!fs.existsSync(tempPath)) {
      fs.mkdirSync(tempPath, { recursive: true });
    }
    return tempPath;
  }

  /**
   * Retorna la ruta raíz del workspace (alias de getWorkspacePath).
   */
  getBasePath() {
    return this.getWorkspacePath();
  }

  /**
   * Configura el workspaceRoot en electron-store y refresca la ruta.
   * @param {string} newPath — nueva ruta de workspace
   */
  setWorkspacePath(newPath) {
    if (!newPath || typeof newPath !== 'string' || !newPath.trim()) {
      throw new Error('Workspace path inválido');
    }
    const resolved = path.resolve(newPath.trim());

    // Persistir en config
    this.config.workspaceRoot = resolved;
    // No guardamos acá — el caller llama saveConfig() aparte

    // Invalidar caché para que el próximo getWorkspacePath() lo resuelva fresco
    this._resolved = false;
    this._workspaceRoot = null;

    console.log(`[WORKSPACE] Nueva ruta configurada: ${resolved}`);
    return resolved;
  }

  async initialize() {
    try {
      // Try to get master key from OS keychain
      try {
        this.masterKey = await keytar.getPassword(this.serviceName, this.accountName);
        
        if (!this.masterKey) {
          this.masterKey = crypto.randomBytes(32).toString('hex');
          await keytar.setPassword(this.serviceName, this.accountName, this.masterKey);
          console.log('Generated new master key and stored in OS keychain');
        }
      } catch (keytarError) {
        console.warn('Keytar not available, using fallback key:', keytarError.message);
        this.masterKey = crypto.randomBytes(32).toString('hex');
      }

      // Load config file first (needed for workspaceRoot from electron-store)
      await this.loadConfig();

      // Resolver y autocrear carpeta respaldos
      const respaldosPath = this.getRespaldosPath();
      if (!fs.existsSync(respaldosPath)) {
        fs.mkdirSync(respaldosPath, { recursive: true });
        console.log(`[RESPALDOS] Carpeta creada: ${respaldosPath}`);
      }

      return this.config;
    } catch (error) {
      console.error('Failed to initialize ConfigManager, using default config:', error);
      this.config = this.getDefaultConfig();
      return this.config;
    }
  }

  async loadConfig() {
    try {
      if (!fs.existsSync(this.configPath)) {
        // Return defaults in-memory only — never create file on disk automatically
        this.config = this.getDefaultConfig();
        console.log('No config file found, using in-memory defaults');
      } else {
        const configData = fs.readFileSync(this.configPath, 'utf8');
        this.config = JSON.parse(configData);
        await this.decryptConfig();
      }
      this.ensureDefaultSshKey();
      return this.config;
    } catch (error) {
      console.error('Failed to load config:', error);
      this.config = this.getDefaultConfig();
      return this.config;
    }
  }

  async saveConfig() {
    try {
      // Encrypt sensitive fields before saving
      await this.encryptConfig();
      
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
      
      // Decrypt again for in-memory use
      await this.decryptConfig();
      
      console.log('Config saved successfully');
    } catch (error) {
      console.error('Failed to save config:', error);
      throw error;
    }
  }

  async encryptConfig() {
    // Use Electron safeStorage for credentials; fallback to legacy AES if unavailable
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[CONFIG] safeStorage not available, using legacy AES encryption');
      await this._legacyEncryptConfig();
      return;
    }

    // Encrypt SSH private keys and passwords using safeStorage
    if (this.config.accounts && Array.isArray(this.config.accounts)) {
      for (const account of this.config.accounts) {
        if (account.originClouds) {
          for (const item of account.originClouds) {
            if (item.sshCredentials?.privateKey) {
              const encrypted = safeStorage.encryptString(item.sshCredentials.privateKey);
              item.sshCredentials.privateKey = '__ss__' + encrypted.toString('base64');
            }
            if (item.sshCredentials?.password) {
              const encrypted = safeStorage.encryptString(item.sshCredentials.password);
              item.sshCredentials.password = '__ss__' + encrypted.toString('base64');
            }
          }
        }
      }
    }

    if (this.config.destinationServers && Array.isArray(this.config.destinationServers)) {
      for (const server of this.config.destinationServers) {
        if (server.sshCredentials?.privateKey) {
          const encrypted = safeStorage.encryptString(server.sshCredentials.privateKey);
          server.sshCredentials.privateKey = '__ss__' + encrypted.toString('base64');
        }
        if (server.sshCredentials?.password) {
          const encrypted = safeStorage.encryptString(server.sshCredentials.password);
          server.sshCredentials.password = '__ss__' + encrypted.toString('base64');
        }
      }
    }

    if (this.config.cloudflare?.apiToken) {
      const encrypted = safeStorage.encryptString(this.config.cloudflare.apiToken);
      this.config.cloudflare.apiToken = '__ss__' + encrypted.toString('base64');
    }

    if (this.config.hostingerMail?.apiToken) {
      const encrypted = safeStorage.encryptString(this.config.hostingerMail.apiToken);
      this.config.hostingerMail.apiToken = '__ss__' + encrypted.toString('base64');
    }
  }

  async decryptConfig() {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[CONFIG] safeStorage not available, using legacy AES decryption');
      await this._legacyDecryptConfig();
      return;
    }

    const decryptField = (value) => {
      if (!value || typeof value !== 'string') return value;
      if (value.startsWith('__ss__')) {
        try {
          const buffer = Buffer.from(value.slice(6), 'base64');
          return safeStorage.decryptString(buffer);
        } catch (err) {
          console.error('[CONFIG] Failed to decrypt safeStorage field:', err.message);
          return null;
        }
      }
      // Fallback: try legacy base64 decode (for backward compat)
      try {
        const decoded = Buffer.from(value, 'base64').toString('utf8');
        // Only use if it looks like a real credential (not garbage from double-decode)
        if (decoded.includes('-----BEGIN') || decoded.length > 4) {
          return decoded;
        }
      } catch {}
      return value;
    };

    if (this.config.accounts && Array.isArray(this.config.accounts)) {
      for (const account of this.config.accounts) {
        if (account.originClouds) {
          for (const item of account.originClouds) {
            if (item.sshCredentials?.privateKey) {
              item.sshCredentials.privateKey = decryptField(item.sshCredentials.privateKey);
            }
            if (item.sshCredentials?.password) {
              item.sshCredentials.password = decryptField(item.sshCredentials.password);
            }
          }
        }
      }
    }

    if (this.config.destinationServers && Array.isArray(this.config.destinationServers)) {
      for (const server of this.config.destinationServers) {
        if (server.sshCredentials?.privateKey) {
          server.sshCredentials.privateKey = decryptField(server.sshCredentials.privateKey);
        }
        if (server.sshCredentials?.password) {
          server.sshCredentials.password = decryptField(server.sshCredentials.password);
        }
      }
    }

    if (this.config.cloudflare?.apiToken && typeof this.config.cloudflare.apiToken === 'string') {
      this.config.cloudflare.apiToken = decryptField(this.config.cloudflare.apiToken);
    }

    if (this.config.hostingerMail?.apiToken && typeof this.config.hostingerMail.apiToken === 'string') {
      this.config.hostingerMail.apiToken = decryptField(this.config.hostingerMail.apiToken);
    }
  }

  async _legacyEncryptConfig() {
    if (this.config.accounts && Array.isArray(this.config.accounts)) {
      this.encryptCredentials(this.config.accounts, 'originClouds');
    }
    if (this.config.destinationServers && Array.isArray(this.config.destinationServers)) {
      this.encryptServerCredentials(this.config.destinationServers);
    }
    
    if (this.config.cloudflare?.apiToken) {
      this.config.cloudflare.apiToken = Buffer.from(this.config.cloudflare.apiToken).toString('base64');
    }
  }

  async _legacyDecryptConfig() {
    if (this.config.accounts && Array.isArray(this.config.accounts)) {
      this.decryptCredentials(this.config.accounts, 'originClouds');
    }
    if (this.config.destinationServers && Array.isArray(this.config.destinationServers)) {
      this.decryptServerCredentials(this.config.destinationServers);
    }
    
    if (this.config.cloudflare?.apiToken && typeof this.config.cloudflare.apiToken === 'string') {
      const token = this.config.cloudflare.apiToken;
      if (token.startsWith('__ss__')) {
        console.warn('[CONFIG] safeStorage no disponible. Token Cloudflare cifrado preservado (fallará validación aguas abajo).');
        return;
      }
      try {
        const decrypted = Buffer.from(token, 'base64').toString('utf8');
        this.config.cloudflare.apiToken = decrypted;
      } catch (error) {
        console.warn('Failed to decrypt Cloudflare token, may be already decrypted or in different format');
      }
    }
  }

  encryptCredentials(accounts, credentialType) {
    for (const account of accounts) {
      if (account[credentialType]) {
        for (const item of account[credentialType]) {
          if (item.sshCredentials?.privateKey) {
            // Simple base64 encoding for demo - in production use proper encryption with IV
            item.sshCredentials.privateKey = Buffer.from(item.sshCredentials.privateKey).toString('base64');
          }
          if (item.sshCredentials?.password) {
            item.sshCredentials.password = Buffer.from(item.sshCredentials.password).toString('base64');
          }
        }
      }
    }
  }

  decryptCredentials(accounts, credentialType) {
    for (const account of accounts) {
      if (account[credentialType]) {
        for (const item of account[credentialType]) {
          if (item.sshCredentials?.privateKey && typeof item.sshCredentials.privateKey === 'string') {
            if (!item.sshCredentials.privateKey.startsWith('__ss__')) {
              try {
                item.sshCredentials.privateKey = Buffer.from(item.sshCredentials.privateKey, 'base64').toString('utf8');
              } catch (error) {
                console.warn(`Failed to decrypt privateKey for ${item.name}, may be already decrypted`);
              }
            }
          }
          if (item.sshCredentials?.password && typeof item.sshCredentials.password === 'string') {
            if (!item.sshCredentials.password.startsWith('__ss__')) {
              try {
                item.sshCredentials.password = Buffer.from(item.sshCredentials.password, 'base64').toString('utf8');
              } catch (error) {
                console.warn(`Failed to decrypt password for ${item.name}, may be already decrypted`);
              }
            }
          }
        }
      }
    }
  }

  encryptServerCredentials(servers) {
    for (const server of servers) {
      if (server.sshCredentials?.privateKey) {
        server.sshCredentials.privateKey = Buffer.from(server.sshCredentials.privateKey).toString('base64');
      }
      if (server.sshCredentials?.password) {
        server.sshCredentials.password = Buffer.from(server.sshCredentials.password).toString('base64');
      }
    }
  }

  decryptServerCredentials(servers) {
    for (const server of servers) {
      if (server.sshCredentials?.privateKey && typeof server.sshCredentials.privateKey === 'string') {
        if (!server.sshCredentials.privateKey.startsWith('__ss__')) {
          try {
            server.sshCredentials.privateKey = Buffer.from(server.sshCredentials.privateKey, 'base64').toString('utf8');
          } catch (error) {
            console.warn(`Failed to decrypt privateKey for ${server.name}, may be already decrypted`);
          }
        }
      }
      if (server.sshCredentials?.password && typeof server.sshCredentials.password === 'string') {
        if (!server.sshCredentials.password.startsWith('__ss__')) {
          try {
            server.sshCredentials.password = Buffer.from(server.sshCredentials.password, 'base64').toString('utf8');
          } catch (error) {
            console.warn(`Failed to decrypt password for ${server.name}, may be already decrypted`);
          }
        }
      }
    }
  }

  ensureDefaultSshKey() {
    if (!this.config.sshKeys) {
      this.config.sshKeys = {};
    }
    if (!this.config.sshKeys.publicKeyPath) {
      this.config.sshKeys.publicKeyPath = path.join(os.homedir(), '.ssh', 'id_rsa.pub');
      console.log('Default SSH public key set:', this.config.sshKeys.publicKeyPath);
    }
  }

  getDefaultConfig() {
    return {
      sshKeys: {
        privateKeyPath: "",
        publicKeyPath: ""
      },
      accounts: [],
      destinationServers: [],
      cloudflare: {
        apiToken: "",
        zoneId: ""
      },
      elementorPro: {
        zipPath: "",
        licenseKey: ""
      },
      googleDrive: {
        credentialsPath: "",
        rootFolderId: ""
      },
      workspaceRoot: ""
    };
  }

  getConfig() {
    return this.config;
  }

  getConfigPath() {
    return this.configPath;
  }

  updateConfig(newConfig) {
    const oldWorkspaceRoot = this.config?.workspaceRoot;
    this.config = { ...this.config, ...newConfig };

    // Si cambió workspaceRoot, invalidar caché para re-resolución
    if (newConfig.workspaceRoot && newConfig.workspaceRoot !== oldWorkspaceRoot) {
      this._resolved = false;
      this._workspaceRoot = null;
      console.log(`[WORKSPACE] workspaceRoot cambió: "${oldWorkspaceRoot}" → "${newConfig.workspaceRoot}"`);
    }

    return this.saveConfig();
  }

  getAccountByName(name) {
    return this.config.accounts.find(account => account.name === name);
  }

  getOriginCloud(accountName, cloudName) {
    const account = this.getAccountByName(accountName);
    if (!account) return null;
    return account.originClouds?.find(cloud => cloud.name === cloudName);
  }

  getDestinationServer(serverName) {
    if (!this.config.destinationServers) return null;
    return this.config.destinationServers.find(server => server.name === serverName);
  }
}

// Singleton instance
let instance = null;

function getConfigManager() {
  if (!instance) {
    instance = new ConfigManager();
  }
  return instance;
}

module.exports = { ConfigManager, getConfigManager };