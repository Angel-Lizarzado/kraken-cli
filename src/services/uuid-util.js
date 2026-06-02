const { v4: uuidv4, v5: uuidv5 } = require('uuid');

class UuidUtil {
  /**
   * Generate a UUID v4 (random)
   */
  static generate() {
    return uuidv4();
  }

  /**
   * Generate a UUID v5 (namespace-based)
   * Useful for generating consistent UUIDs for the same input
   */
  // ⚠️ LEGACY: El namespace 'clinmedia-ops' NO debe cambiarse.
  // Modificarlo rompería la consistencia de los UUIDs históricos generados
  // en bases de datos y logs existentes. Es un valor técnico, no una marca.
  static generateFromName(name, namespace = 'clinmedia-ops') {
    // Create a namespace UUID from the namespace string
    const namespaceUuid = uuidv5(namespace, uuidv5.DNS);
    return uuidv5(name, namespaceUuid);
  }

  /**
   * Generate a UUID for a temporary script filename
   * Uses the pattern: {uuid}_{originalName} or just {uuid} if no originalName
   */
  static generateScriptName(originalName = null) {
    const uuid = this.generate().replace(/-/g, ''); // Remove dashes for shorter filename
    if (originalName) {
      // Extract extension if present
      const extension = originalName.includes('.') 
        ? originalName.substring(originalName.lastIndexOf('.'))
        : '';
      const nameWithoutExt = originalName.includes('.')
        ? originalName.substring(0, originalName.lastIndexOf('.'))
        : originalName;
      
      return `${uuid}_${nameWithoutExt}${extension}`;
    }
    return `${uuid}.sh`;
  }

  /**
   * Generate a UUID for a task
   * Includes timestamp prefix for sortability
   */
  static generateTaskId() {
    const timestamp = Date.now().toString(36); // Base36 for shorter representation
    const uuid = this.generate().replace(/-/g, '').substring(0, 8); // First 8 chars of UUID
    return `task_${timestamp}_${uuid}`;
  }

  /**
   * Generate a UUID for a workspace directory
   */
  static generateWorkspaceId() {
    const timestamp = Date.now().toString(36);
    const uuid = this.generate().replace(/-/g, '').substring(0, 12);
    return `ws_${timestamp}_${uuid}`;
  }

  /**
   * Validate if a string is a valid UUID
   */
  static isValid(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }

  /**
   * Generate a short ID (8 chars) from a UUID
   * Useful for display purposes
   */
  static shortId(uuid = null) {
    const sourceUuid = uuid || this.generate();
    return sourceUuid.replace(/-/g, '').substring(0, 8);
  }

  /**
   * Generate a batch of UUIDs
   */
  static generateBatch(count) {
    const uuids = [];
    for (let i = 0; i < count; i++) {
      uuids.push(this.generate());
    }
    return uuids;
  }

  /**
   * Create a deterministic UUID for a server based on its configuration
   * Useful for identifying the same server across sessions
   */
  static generateServerId(serverConfig) {
    const key = `${serverConfig.host}:${serverConfig.port}:${serverConfig.username}`;
    return this.generateFromName(key, 'clinmedia-server');
  }

  /**
   * Create a deterministic UUID for a domain operation
   */
  static generateDomainOperationId(account, cloud, domain, operation) {
    const key = `${account}:${cloud}:${domain}:${operation}`;
    return this.generateFromName(key, 'clinmedia-domain-op');
  }
}

module.exports = UuidUtil;