const { syncDomain } = require('./src/infrastructure/sync-cloudflare');
const { getConfigManager } = require('./src/services/config-manager');

async function run() {
  const configManager = getConfigManager();
  await configManager.initialize();
  const config = configManager.getConfig();
  console.log('Token exists:', !!config.cloudflare?.apiToken);
  console.log('Account ID exists:', !!config.cloudflare?.accountId);

  try {
    const res = await syncDomain('abogadoargila.es');
    console.log(res);
  } catch (err) {
    console.error(err);
  }
}

run();
