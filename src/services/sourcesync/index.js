/**
 * @module SOURCESYNC
 * @description Módulo de despliegue automatizado de proyectos Next.js (Standalone) en Plesk.
 *
 * Punto de entrada centralizado del módulo SOURCESYNC.
 * Expone las funciones públicas de los 4 servicios que componen el orquestador.
 *
 * Uso desde un IPC handler:
 *   const SOURCESYNC = require('./services/SOURCESYNC');
 *   const resultado = await SOURCESYNC.orchestrarDespliegue(ssh, config, onProgreso);
 */

'use strict';

const { orchestrarDespliegue, dispararFetch } = require('./deployOrchestrator');
const { autorizarLlaveDespliegueGitHub } = require('./sshGitHub');
const { garantizarVersionNode, VERSION_FALLBACK } = require('./nodeManager');
const { configurarRepoEnPlesk, transformarUrlSsh } = require('./pleskGit');
const { ensureSubscriptionExists } = require('./domainManager');

module.exports = {
  // Orquestador principal (punto de entrada recomendado)
  orchestrarDespliegue,
  dispararFetch,

  // Servicios atómicos (para uso independiente)
  autorizarLlaveDespliegueGitHub,
  garantizarVersionNode,
  configurarRepoEnPlesk,
  transformarUrlSsh,
  ensureSubscriptionExists,

  // Constantes
  VERSION_FALLBACK,
};

