'use strict';

class StepError extends Error {
  constructor(stepNum, message) {
    super(message);
    this.name = 'StepError';
    this.stepNum = stepNum;
  }
}

module.exports = { StepError };
