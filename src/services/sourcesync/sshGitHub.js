/**
 * @module sourcesync/sshGitHub
 * @description Vinculación de llave SSH Ed25519 en Plesk con repositorios de GitHub.
 *
 * Flujo:
 *  1. Genera llave Ed25519 en el servidor (si no existe).
 *  2. Registra la llave pública como Deploy Key en el repo de GitHub via API REST.
 *  3. Agrega github.com a known_hosts del servidor.
 *  4. Configura ~/.ssh/config con un alias por dominio para soporte multi-repo.
 *
 * ADVERTENCIA: Ejecutar solo si el dominio NO está vinculado aún a GitHub.
 * La función es idempotente en cuanto a known_hosts, pero no en cuanto a GitHub
 * (registrar la misma llave dos veces en GitHub falla con 422 si el título coincide).
 */

'use strict';

const axios = require('axios');

/**
 * Genera la llave Ed25519 en el servidor Plesk y la registra como
 * Deploy Key en el repositorio de GitHub indicado.
 *
 * @param {import('node-ssh').NodeSSH} ssh  - Instancia NodeSSH ya conectada.
 * @param {string} githubToken              - Personal Access Token con permiso `repo`.
 * @param {string} repoOwner               - Usuario u organización dueña del repo (ej: "acme-corp").
 * @param {string} repoName                - Nombre del repositorio (ej: "mi-proyecto").
 * @param {string} domain                  - Dominio Plesk (ej: "app.example.com").
 * @returns {Promise<{ llavePub: string, alias: string }>}
 * @throws {Error} Si falla la generación de llave o el registro en GitHub.
 */
async function autorizarLlaveDespliegueGitHub(ssh, githubToken, repoOwner, repoName, domain) {
  // Construir ruta de llave única por dominio para soporte multi-repo
  const domainSlug = domain.replace(/\./g, '_');
  const keyPath = `/root/.ssh/id_ed25519_${domainSlug}`;

  // ── Paso 1: Generar llave Ed25519 en el servidor Plesk ───────────────────
  console.log(`[SOURCESYNC:GitHub] Generando llave Ed25519 en ${keyPath}...`);

  // Verificar si ya existe la llave para evitar sobrescrituras accidentales
  const { stdout: existeArchivo } = await ssh.execCommand(
    `[ -f "${keyPath}" ] && echo "SI" || echo "NO"`
  );

  if (existeArchivo.trim() === 'SI') {
    console.log(`[SOURCESYNC:GitHub] Llave ya existe en ${keyPath}. Reutilizando.`);
  } else {
    const genResult = await ssh.execCommand(
      `ssh-keygen -t ed25519 -C "plesk-deploy-${domain}" -f ${keyPath} -N ""`,
      { execOptions: { pty: false } }
    );

    if (genResult.code !== 0) {
      throw new Error(
        `[SOURCESYNC:GitHub] Fallo al generar llave Ed25519 para ${domain}: ${genResult.stderr}`
      );
    }
  }

  // Leer llave pública generada
  const { stdout: llavePub, code: codeLectura, stderr: errLectura } = await ssh.execCommand(
    `cat ${keyPath}.pub`
  );

  if (codeLectura !== 0 || !llavePub.trim()) {
    throw new Error(
      `[SOURCESYNC:GitHub] No se pudo leer la llave pública en ${keyPath}.pub. Error: ${errLectura}`
    );
  }

  const llavePubLimpia = llavePub.trim();
  console.log(`[SOURCESYNC:GitHub] Llave pública leída correctamente (${llavePubLimpia.length} chars).`);

  // ── Paso 2: Registrar llave en GitHub vía API REST ────────────────────────
  console.log(`[SOURCESYNC:GitHub] Registrando Deploy Key en ${repoOwner}/${repoName}...`);

  try {
    await axios.post(
      `https://api.github.com/repos/${repoOwner}/${repoName}/keys`,
      {
        title: `KrakenCLI-${domain}`,
        key: llavePubLimpia,
        read_only: true,
      },
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          'X-GitHub-Api-Version': '2022-11-28',
          Accept: 'application/vnd.github+json',
        },
        timeout: 15000,
      }
    );
    console.log(`[SOURCESYNC:GitHub] Deploy Key registrada exitosamente en GitHub.`);
  } catch (axiosError) {
    // Extraer mensaje de error de la respuesta de GitHub
    const statusCode = axiosError.response?.status;
    const mensajeGitHub = axiosError.response?.data?.message || axiosError.message;

    // 422 = llave ya registrada con ese título — puede ser intencional (re-deploy)
    if (statusCode === 422) {
      console.warn(
        `[SOURCESYNC:GitHub] La llave ya existe en GitHub (422). Continuando con la existente.`
      );
    } else {
      throw new Error(
        `[SOURCESYNC:GitHub] Error al registrar Deploy Key en GitHub (HTTP ${statusCode}): ${mensajeGitHub}`
      );
    }
  }

  // ── Paso 3: Agregar github.com a known_hosts ─────────────────────────────
  console.log(`[SOURCESYNC:GitHub] Escaneando fingerprint de GitHub en known_hosts...`);

  // ssh-keyscan puede fallar silenciosamente si github.com ya está en known_hosts
  // Usamos grep para evitar duplicados antes de agregar
  await ssh.execCommand(
    `grep -q "github.com" ~/.ssh/known_hosts 2>/dev/null || ssh-keyscan -H github.com >> ~/.ssh/known_hosts 2>/dev/null`
  );

  // ── Paso 4: Configurar alias SSH en ~/.ssh/config ─────────────────────────
  // El alias permite tener múltiples llaves para múltiples repos en el mismo servidor
  const alias = `github.com-${domain.replace(/\./g, '-')}`;
  console.log(`[SOURCESYNC:GitHub] Configurando alias SSH: ${alias}...`);

  // Verificar si el alias ya existe en ~/.ssh/config para evitar duplicados
  const { stdout: existeAlias } = await ssh.execCommand(
    `grep -q "Host ${alias}" ~/.ssh/config 2>/dev/null && echo "SI" || echo "NO"`
  );

  if (existeAlias.trim() === 'NO') {
    // Asegurar que el archivo config existe con permisos correctos
    await ssh.execCommand(`touch ~/.ssh/config && chmod 600 ~/.ssh/config`);

    // Entrada de configuración para el alias (una por dominio)
    const entradaConfig = [
      ``,
      `Host ${alias}`,
      `  HostName github.com`,
      `  User git`,
      `  IdentityFile ${keyPath}`,
      `  IdentitiesOnly yes`,
    ].join('\n');

    // Usar printf para manejar correctamente los saltos de línea
    const { code: codeConfig, stderr: errConfig } = await ssh.execCommand(
      `printf '%s\\n' "${entradaConfig}" >> ~/.ssh/config`
    );

    if (codeConfig !== 0) {
      throw new Error(
        `[SOURCESYNC:GitHub] No se pudo escribir en ~/.ssh/config: ${errConfig}`
      );
    }

    console.log(`[SOURCESYNC:GitHub] Alias "${alias}" configurado en ~/.ssh/config.`);
  } else {
    console.log(`[SOURCESYNC:GitHub] Alias "${alias}" ya existe en ~/.ssh/config. Sin cambios.`);
  }

  return { llavePub: llavePubLimpia, alias };
}

module.exports = { autorizarLlaveDespliegueGitHub };
