'use strict';

function assertNotAborted(signal) {
  if (signal?.aborted) {
    throw new Error('Abortado por el usuario');
  }
}

module.exports = { assertNotAborted };
