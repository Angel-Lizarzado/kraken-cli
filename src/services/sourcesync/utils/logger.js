'use strict';

function createStepLogger(emit, stepNum, totalSteps) {
  return {
    info: (msg) => emit(stepNum, `[Step ${stepNum}/${totalSteps}] ${msg}`, 'info'),
    success: (msg) => emit(stepNum, `[Step ${stepNum}/${totalSteps}] ${msg}`, 'success'),
    warn: (msg) => emit(stepNum, `[Step ${stepNum}/${totalSteps}] [WARNING] ${msg}`, 'warn'),
    detail: (msg, level = 'info') => emit(stepNum, `  └ ${msg}`, level),
  };
}

module.exports = { createStepLogger };
