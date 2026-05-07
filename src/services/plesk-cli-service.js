const { getSshService } = require('./ssh-service');
const { getProgressEmitter } = require('./progress-emitter');

class PleskCliService {
  constructor() {
    this.sshService = getSshService();
    this.progressEmitter = getProgressEmitter();
  }

  async createSubscription(client, domain, options = {}) {
    const taskId = this.progressEmitter.createTask('plesk-subscription', domain, `Creating subscription for ${domain}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Preparing to create subscription for ${domain}`);
      
      // Build plesk command
      let command = `plesk bin subscription --create ${domain}`;
      
      // Add owner (default to KitDigital as per requirements)
      const owner = options.owner || 'KitDigital';
      command += ` -owner "${owner}"`;
      
      // Add service plan if provided
      if (options.servicePlan) {
        command += ` -service-plan "${options.servicePlan}"`;
      }
      
      // Add IP address if provided
      if (options.ipAddress) {
        command += ` -ip "${options.ipAddress}"`;
      }
      
      // Add login if provided
      if (options.login) {
        command += ` -login "${options.login}"`;
      }
      
      // Add password if provided
      if (options.password) {
        command += ` -passwd "${options.password}"`;
      }
      
      this.progressEmitter.emitProgress(taskId, 30, `Creating subscription with owner: ${owner}`);
      
      // Execute command
      const result = await this.sshService.executeCommand(client, command);
      
      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 100, `Subscription created successfully for ${domain}`);
        this.progressEmitter.completeTask(taskId, `Subscription created for ${domain}`);
        
        return {
          success: true,
          domain,
          owner,
          message: result.stdout,
          rawResult: result
        };
      } else {
        throw new Error(`Plesk CLI failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async installLetsEncryptSSL(client, domain, options = {}) {
    const taskId = this.progressEmitter.createTask('plesk-ssl', domain, `Installing Let's Encrypt SSL for ${domain}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting SSL installation for ${domain}`);
      
      let command = `plesk bin ssl --install-letsencrypt -domain ${domain}`;
      
      // Add email if provided
      if (options.email) {
        command += ` -email ${options.email}`;
      }
      
      // Add webroot if provided
      if (options.webroot) {
        command += ` -webroot "${options.webroot}"`;
      }
      
      this.progressEmitter.emitProgress(taskId, 30, `Requesting SSL certificate for ${domain}`);
      
      const result = await this.sshService.executeCommand(client, command);
      
      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 80, `SSL certificate installed, enabling for ${domain}`);
        
        // Enable SSL for the domain
        await this.sshService.executeCommand(
          client,
          `plesk bin domain --update ${domain} -ssl true -ssl-certificate "Let's Encrypt"`
        );
        
        this.progressEmitter.emitProgress(taskId, 100, `SSL enabled successfully for ${domain}`);
        this.progressEmitter.completeTask(taskId, `Let's Encrypt SSL installed for ${domain}`);
        
        return {
          success: true,
          domain,
          type: 'letsencrypt',
          message: result.stdout,
          rawResult: result
        };
      } else {
        throw new Error(`Let's Encrypt installation failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async installCloudflareSSL(client, domain, cloudflareToken) {
    const taskId = this.progressEmitter.createTask('plesk-ssl', domain, `Installing Cloudflare SSL for ${domain}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting Cloudflare SSL installation for ${domain}`);
      
      const command = `plesk bin ssl --install-cloudflare -domain ${domain} -token "${cloudflareToken}"`;
      
      this.progressEmitter.emitProgress(taskId, 30, `Requesting Cloudflare SSL certificate for ${domain}`);
      
      const result = await this.sshService.executeCommand(client, command);
      
      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 80, `Cloudflare SSL certificate installed, enabling for ${domain}`);
        
        // Enable SSL for the domain
        await this.sshService.executeCommand(
          client,
          `plesk bin domain --update ${domain} -ssl true -ssl-certificate "Cloudflare"`
        );
        
        this.progressEmitter.emitProgress(taskId, 100, `Cloudflare SSL enabled successfully for ${domain}`);
        this.progressEmitter.completeTask(taskId, `Cloudflare SSL installed for ${domain}`);
        
        return {
          success: true,
          domain,
          type: 'cloudflare',
          message: result.stdout,
          rawResult: result
        };
      } else {
        throw new Error(`Cloudflare SSL installation failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async installBulkLetsEncrypt(client, domains, options = {}) {
    const taskId = this.progressEmitter.createTask('plesk-bulk-ssl', 'all', `Starting bulk SSL for ${domains.length} domains`);

    try {
      const results = [];
      const email = options.email || 'clinmediadev@gmail.com';
      const webroot = options.webroot || '/var/www/html';

      for (let i = 0; i < domains.length; i++) {
        const domain = domains[i];
        const baseProgress = Math.round((i / domains.length) * 90);

        try {
          this.progressEmitter.emitProgress(taskId, baseProgress, `[${i + 1}/${domains.length}] Requesting SSL for ${domain}`);

          let command = `plesk bin ssl --install-letsencrypt -domain ${domain} -email ${email}`;
          if (options.webroot) {
            command += ` -webroot "${options.webroot}"`;
          }

          const result = await this.sshService.executeCommand(client, command);

          if (result.code === 0) {
            await this.sshService.executeCommand(
              client,
              `plesk bin domain --update ${domain} -ssl true -ssl-certificate "Let's Encrypt"`
            );

            this.progressEmitter.emitProgress(taskId, baseProgress + 10, `SSL installed and enabled for ${domain}`);
            results.push({ domain, success: true, message: result.stdout });
          } else {
            const errMsg = result.stderr || result.stdout;
            this.progressEmitter.emitProgress(taskId, baseProgress + 5, `SSL failed for ${domain}: ${errMsg}`);
            results.push({ domain, success: false, error: errMsg });
          }
        } catch (error) {
          console.error(`SSL failed for ${domain}:`, error.message);
          this.progressEmitter.emitProgress(taskId, baseProgress + 5, `Error on ${domain}: ${error.message}`);
          results.push({ domain, success: false, error: error.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      this.progressEmitter.emitProgress(taskId, 95, `SSL batch finished: ${successCount}/${domains.length} OK`);
      this.progressEmitter.completeTask(taskId, `Bulk SSL completed (${successCount}/${domains.length})`);

      return {
        success: true,
        results,
        summary: {
          total: domains.length,
          successful: successCount,
          failed: domains.length - successCount
        }
      };
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async exportDnsZone(client, domain) {
    const taskId = this.progressEmitter.createTask('plesk-dns', domain, `Exporting DNS zone for ${domain}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting DNS zone export for ${domain}`);
      
      const command = `plesk bin dns --export ${domain}`;
      
      this.progressEmitter.emitProgress(taskId, 30, `Exporting DNS records for ${domain}`);
      
      const result = await this.sshService.executeCommand(client, command);
      
      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 100, `DNS zone exported successfully for ${domain}`);
        this.progressEmitter.completeTask(taskId, `DNS zone exported for ${domain}`);
        
        // Parse DNS records from output
        const dnsRecords = this.parseDnsExport(result.stdout);
        
        return {
          success: true,
          domain,
          records: dnsRecords,
          rawExport: result.stdout,
          message: `Exported ${dnsRecords.length} DNS records`
        };
      } else {
        throw new Error(`DNS export failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async clearCache(client, domain = null) {
    const target = domain ? `domain ${domain}` : 'all domains';
    const taskId = this.progressEmitter.createTask('plesk-cache', domain || 'all', `Clearing cache for ${target}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting cache clearance for ${target}`);
      
      const command = domain 
        ? `plesk bin domain --clear-cache ${domain}`
        : `plesk bin domain --clear-cache`;
      
      this.progressEmitter.emitProgress(taskId, 30, `Clearing cache for ${target}`);
      
      const result = await this.sshService.executeCommand(client, command);
      
      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 100, `Cache cleared successfully for ${target}`);
        this.progressEmitter.completeTask(taskId, `Cache cleared for ${target}`);
        
        return {
          success: true,
          target,
          message: result.stdout,
          rawResult: result
        };
      } else {
        throw new Error(`Cache clearance failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async createDatabase(client, domain, databaseName, databaseUser, password) {
    const taskId = this.progressEmitter.createTask('plesk-database', domain, `Creating database for ${domain}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting database creation for ${domain}`);
      
      // Create database
      const createDbCommand = `plesk bin database --create ${databaseName} -domain ${domain} -type mysql`;
      const createDbResult = await this.sshService.executeCommand(client, createDbCommand);
      
      if (createDbResult.code !== 0) {
        throw new Error(`Database creation failed: ${createDbResult.stderr || createDbResult.stdout}`);
      }
      
      this.progressEmitter.emitProgress(taskId, 40, `Database created, creating user`);
      
      // Create database user
      const createUserCommand = `plesk bin database --create-user ${databaseUser} -passwd "${password}" -database ${databaseName}`;
      const createUserResult = await this.sshService.executeCommand(client, createUserCommand);
      
      if (createUserResult.code !== 0) {
        throw new Error(`Database user creation failed: ${createUserResult.stderr || createUserResult.stdout}`);
      }
      
      this.progressEmitter.emitProgress(taskId, 70, `User created, granting permissions`);
      
      // Grant all privileges to user
      const grantCommand = `plesk bin database --assign-user ${databaseUser} -database ${databaseName}`;
      const grantResult = await this.sshService.executeCommand(client, grantCommand);
      
      if (grantResult.code !== 0) {
        throw new Error(`Permission grant failed: ${grantResult.stderr || grantResult.stdout}`);
      }
      
      this.progressEmitter.emitProgress(taskId, 100, `Database setup completed for ${domain}`);
      this.progressEmitter.completeTask(taskId, `Database created for ${domain}`);
      
      return {
        success: true,
        domain,
        database: databaseName,
        user: databaseUser,
        message: 'Database and user created successfully'
      };
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async importDatabase(client, domain, databaseName, sqlFilePath) {
    const taskId = this.progressEmitter.createTask('plesk-database', domain, `Importing database for ${domain}`);
    
    try {
      this.progressEmitter.emitProgress(taskId, 10, `Starting database import for ${domain}`);
      
      // Import SQL file
      const command = `mysql -u admin -p\$(cat /etc/psa/.psa.shadow) ${databaseName} < "${sqlFilePath}"`;
      
      this.progressEmitter.emitProgress(taskId, 30, `Importing SQL file into ${databaseName}`);
      
      const result = await this.sshService.executeCommand(client, command);
      
      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 80, `Database imported, cleaning up transients`);
        
        // Clean up WordPress transients (as per requirements)
        const cleanupCommand = `mysql -u admin -p\$(cat /etc/psa/.psa.shadow) ${databaseName} -e "DELETE FROM wp_options WHERE option_name LIKE '%_transient_%';"`;
        await this.sshService.executeCommand(client, cleanupCommand);
        
        this.progressEmitter.emitProgress(taskId, 100, `Database import completed for ${domain}`);
        this.progressEmitter.completeTask(taskId, `Database imported for ${domain}`);
        
        return {
          success: true,
          domain,
          database: databaseName,
          message: 'Database imported and transients cleaned'
        };
      } else {
        throw new Error(`Database import failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  parseDnsExport(exportText) {
    const records = [];
    const lines = exportText.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Parse typical DNS export format: name TTL class type data
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 5) {
        const [name, ttl, cls, type, ...dataParts] = parts;
        const data = dataParts.join(' ');

        // ── Guard 1: Skip AAAA records by default (IPv6 misconfig prevention) ──
        if (type === 'AAAA') continue;

        records.push({
          name,
          ttl: parseInt(ttl) || 3600,
          class: cls,
          type,
          data
        });
      }
    }

    // ── Guard 2+3: Sort — A(@) + CNAME(www) first, then MX, TXT, then rest ──
    const PRIORITY_ORDER = ['A', 'CNAME', 'MX', 'TXT'];
    records.sort((a, b) => {
      const aIsApex = a.name === '@' && a.type === 'A';
      const bIsApex = b.name === '@' && b.type === 'A';
      if (aIsApex && !bIsApex) return -1;
      if (!aIsApex && bIsApex) return 1;

      const aIsWww = a.name === 'www' && a.type === 'CNAME';
      const bIsWww = b.name === 'www' && b.type === 'CNAME';
      if (aIsWww && !bIsWww) return -1;
      if (!aIsWww && bIsWww) return 1;

      const aPrio = PRIORITY_ORDER.indexOf(a.type);
      const bPrio = PRIORITY_ORDER.indexOf(b.type);
      const aIdx = aPrio === -1 ? 99 : aPrio;
      const bIdx = bPrio === -1 ? 99 : bPrio;
      return aIdx - bIdx;
    });

    return records;
  }

  async rebootServer(client) {
    const taskId = this.progressEmitter.createTask('plesk-reboot', 'server', 'Rebooting server');

    try {
      this.progressEmitter.emitProgress(taskId, 20, 'Initiating server reboot...');

      const result = await this.sshService.executeCommand(client, 'shutdown -r now');

      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 100, 'Server reboot command executed successfully');
        this.progressEmitter.completeTask(taskId, 'Server reboot initiated');

        return {
          success: true,
          message: 'Reboot command executed successfully'
        };
      } else {
        throw new Error(`Reboot failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async shutdownServer(client) {
    const taskId = this.progressEmitter.createTask('plesk-shutdown', 'server', 'Shutting down server');

    try {
      this.progressEmitter.emitProgress(taskId, 20, 'Initiating server shutdown...');

      const result = await this.sshService.executeCommand(client, 'shutdown -h now');

      if (result.code === 0) {
        this.progressEmitter.emitProgress(taskId, 100, 'Server shutdown command executed successfully');
        this.progressEmitter.completeTask(taskId, 'Server shutdown initiated');

        return {
          success: true,
          message: 'Shutdown command executed successfully'
        };
      } else {
        throw new Error(`Shutdown failed: ${result.stderr || result.stdout}`);
      }
    } catch (error) {
      this.progressEmitter.emitError(taskId, error, true);
      throw error;
    }
  }

  async getServerInfo(client) {
    try {
      const [versionResult, domainsResult] = await Promise.all([
        this.sshService.executeCommand(client, 'plesk version'),
        this.sshService.executeCommand(client, 'plesk bin domain --list')
      ]);
      
      const domains = domainsResult.stdout.split('\n').filter(d => d.trim());
      
      return {
        pleskVersion: versionResult.stdout.trim(),
        domainCount: domains.length,
        domains: domains.slice(0, 10), // First 10 domains
        raw: {
          version: versionResult,
          domains: domainsResult
        }
      };
    } catch (error) {
      console.warn('Failed to get Plesk server info:', error.message);
      return {
        pleskVersion: 'Unknown',
        domainCount: 0,
        domains: [],
        error: error.message
      };
    }
  }
}

// Singleton instance
let instance = null;

function getPleskCliService() {
  if (!instance) {
    instance = new PleskCliService();
  }
  return instance;
}

module.exports = { PleskCliService, getPleskCliService };