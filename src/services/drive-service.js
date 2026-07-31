const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

class DriveService {
  constructor() {
    this.drive = null;
  }

  /**
   * Crea y retorna un cliente OAuth2 usando credentialsPath.
   */
  _getOAuth2Client(credentialsPath) {
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(`Archivo de credenciales no encontrado en: ${credentialsPath}`);
    }
    const content = fs.readFileSync(credentialsPath, 'utf8');
    const credentials = JSON.parse(content);
    // Para Desktop Apps, suele venir bajo "installed" o "web"
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    // Forzamos el uso de un puerto específico en loopback IP para evitar conflictos con IIS/Apache locales
    // Google Cloud permite puertos dinámicos en 127.0.0.1 para clientes de tipo "Desktop app"
    const redirectUri = 'http://127.0.0.1:3000';
    return new google.auth.OAuth2(client_id, client_secret, redirectUri);
  }

  get _tokenPath() {
    const { getConfigManager } = require('./config-manager');
    const configPath = getConfigManager().getConfigPath();
    return path.join(path.dirname(configPath), 'token.json');
  }

  /**
   * Carga el token guardado y autentica el servicio.
   */
  async authenticate(credentialsPath) {
    this._currentCredentialsPath = credentialsPath;
    const oAuth2Client = this._getOAuth2Client(credentialsPath);

    if (!fs.existsSync(this._tokenPath)) {
      throw new Error('No hay sesión de Google activa. Ve a la Configuración y conecta tu cuenta.');
    }

    const token = fs.readFileSync(this._tokenPath, 'utf8');
    oAuth2Client.setCredentials(JSON.parse(token));
    
    // Configurar listener para guardar automáticamente si el token se refresca
    oAuth2Client.on('tokens', (tokens) => {
      if (tokens.refresh_token) {
        // Combinar con el existente para no perder el refresh_token si solo envían access_token
        const currentToken = JSON.parse(fs.readFileSync(this._tokenPath, 'utf8') || '{}');
        const newToken = { ...currentToken, ...tokens };
        fs.writeFileSync(this._tokenPath, JSON.stringify(newToken));
      } else {
        const currentToken = JSON.parse(fs.readFileSync(this._tokenPath, 'utf8') || '{}');
        const newToken = { ...currentToken, ...tokens };
        fs.writeFileSync(this._tokenPath, JSON.stringify(newToken));
      }
    });

    this.drive = google.drive({ version: 'v3', auth: oAuth2Client });
    console.log('[DRIVE] Autenticación OAuth2 con Google Drive exitosa');
  }

  /**
   * Retorna la URL de autorización para que el usuario inicie sesión en el navegador.
   */
  getAuthUrl(credentialsPath) {
    this._currentCredentialsPath = credentialsPath;
    const oAuth2Client = this._getOAuth2Client(credentialsPath);
    const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive'];
    
    return oAuth2Client.generateAuthUrl({
      access_type: 'offline', // Importante para recibir el refresh_token
      prompt: 'consent', // Forzar siempre para obtener el refresh_token
      scope: SCOPES,
    });
  }

  /**
   * Intercambia el código por el token de acceso y lo guarda.
   */
  async authorizeWithCode(credentialsPath, code) {
    this._currentCredentialsPath = credentialsPath;
    const oAuth2Client = this._getOAuth2Client(credentialsPath);
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(this._tokenPath, JSON.stringify(tokens));
    this.drive = google.drive({ version: 'v3', auth: oAuth2Client });
    console.log('[DRIVE] Autorización OAuth2 completada y token guardado.');
  }
  
  /**
   * Verifica si existe una sesión válida (token.json existe).
   */
  async checkAuth(credentialsPath) {
    this._currentCredentialsPath = credentialsPath;
    return fs.existsSync(this._tokenPath);
  }

  /**
   * Cierra sesión borrando el token local.
   */
  logout(credentialsPath) {
    this._currentCredentialsPath = credentialsPath;
    if (fs.existsSync(this._tokenPath)) {
      fs.unlinkSync(this._tokenPath);
    }
    this.drive = null;
  }

  /**
   * Busca una carpeta por nombre dentro de un parentId. Si no existe, la crea.
   */
  async findOrCreateFolder(folderName, parentId) {
    if (!this.drive) throw new Error('DriveService no está autenticado');

    const query = `name='${folderName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    
    const res = await this.drive.files.list({
      q: query,
      fields: 'files(id, name)',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    if (res.data.files && res.data.files.length > 0) {
      return res.data.files[0].id;
    }

    // No existe, creamos la carpeta
    const fileMetadata = {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    };
    
    const createRes = await this.drive.files.create({
      resource: fileMetadata,
      fields: 'id',
      supportsAllDrives: true
    });
    
    return createRes.data.id;
  }

  /**
   * Resuelve una ruta completa creando las carpetas necesarias recursivamente.
   * pathArray: ['hostinger', 'cloud16', 'dominio.com']
   */
  async resolvePath(rootId, pathArray) {
    let currentParentId = rootId;
    for (const folderName of pathArray) {
      currentParentId = await this.findOrCreateFolder(folderName, currentParentId);
    }
    return currentParentId;
  }

  /**
   * Verifica si un archivo con el nombre especificado ya existe dentro de la carpeta (parentId) en Drive.
   */
  async fileExists(fileName, parentId) {
    if (!this.drive) throw new Error('DriveService no está autenticado');

    const query = `name='${fileName}' and '${parentId}' in parents and trashed=false`;
    const res = await this.drive.files.list({
      q: query,
      fields: 'files(id, name, size)',
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    return res.data.files && res.data.files.length > 0;
  }

  /**
   * Sube un archivo pesado usando stream con progreso.
   */
  async uploadFile(filePath, parentId, onProgress = null) {
    if (!this.drive) throw new Error('DriveService no está autenticado');
    if (!fs.existsSync(filePath)) throw new Error(`Archivo a subir no existe: ${filePath}`);

    const fileName = path.basename(filePath);
    const fileSize = fs.statSync(filePath).size;
    
    const fileMetadata = {
      name: fileName,
      parents: [parentId]
    };
    
    const media = {
      mimeType: 'application/gzip',
      body: fs.createReadStream(filePath)
    };

    console.log(`[DRIVE] Iniciando subida de ${fileName} (${Math.round(fileSize/1024/1024)} MB)...`);

    const res = await this.drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
      supportsAllDrives: true
    }, {
      onUploadProgress: evt => {
        if (onProgress && fileSize > 0) {
          const progress = Math.round((evt.bytesRead / fileSize) * 100);
          onProgress(progress, evt.bytesRead, fileSize);
        }
      }
    });

    console.log(`[DRIVE] Subida completada. ID en Drive: ${res.data.id}`);
    return res.data.id;
  }
}

let instance = null;
function getDriveService() {
  if (!instance) {
    instance = new DriveService();
  }
  return instance;
}

module.exports = {
  getDriveService,
  DriveService
};
