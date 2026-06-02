'use strict';

function validateInputs({ domain, webRoot, sysUser }) {
  const DOMAIN_REGEX = /^[a-zA-Z0-9.\-]+$/;
  const PATH_REGEX = /^[a-zA-Z0-9.\-_\/]+$/;
  const USER_REGEX = /^[a-zA-Z0-9.\-_]+$/;

  if (!DOMAIN_REGEX.test(domain)) {
    throw new Error(`Dominio inválido: ${domain}`);
  }
  if (!PATH_REGEX.test(webRoot)) {
    throw new Error(`Ruta webRoot inválida: ${webRoot}`);
  }
  if (!USER_REGEX.test(sysUser)) {
    throw new Error(`Usuario sysUser inválido: ${sysUser}`);
  }
}

module.exports = { validateInputs };
