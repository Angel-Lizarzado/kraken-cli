'use strict';

function extractInstanceId(output) {
  const idMatch = output.match(/(?:instance[- ]id[:\s]+)?(\d+)/i);
  if (idMatch) {
    return idMatch[1];
  }
  return null;
}

function wpCmd(instanceId, args, sysUser, webRoot) {
  if (instanceId) {
    return `plesk ext wp-toolkit --wp-cli -instance-id ${instanceId} -- ${args} 2>&1`;
  }
  return `su -l ${sysUser} -s /bin/bash -c "export PATH=/usr/local/bin:/usr/bin:/bin:$PATH; cd ${webRoot} && wp ${args} --allow-root"`;
}

module.exports = { extractInstanceId, wpCmd };
