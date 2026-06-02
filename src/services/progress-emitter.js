const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');

class ProgressEmitter extends EventEmitter {
  constructor() {
    super();
    this.tasks = new Map(); // taskId -> task info

    // ── Throttle: máx 5 progress events por segundo ──
    this._throttleWindow = 1000; // 1 segundo
    this._throttleMax = 5;      // máx mensajes por ventana
    this._throttleQueue = [];   // timestamps de eventos enviados
    this._consoleThrottleMap = new Map(); // Para limitar logs de consola
  }

  /**
   * Rate-limiter: retorna true si podemos emitir, false si hay que skipear.
   */
  _throttleAllowed() {
    const now = Date.now();
    // Podar timestamps viejos
    this._throttleQueue = this._throttleQueue.filter(t => now - t < this._throttleWindow);
    if (this._throttleQueue.length >= this._throttleMax) {
      return false; // excedido el límite
    }
    this._throttleQueue.push(now);
    return true;
  }

  createTask(module, domain, initialMessage = 'Starting task') {
    const taskId = uuidv4();
    
    const taskInfo = {
      taskId,
      module,
      domain,
      progress: 0,
      message: initialMessage,
      startTime: Date.now(),
      status: 'running',
      errors: []
    };
    
    this.tasks.set(taskId, taskInfo);
    
    // Emit initial progress
    this.emitProgress(taskId, 0, initialMessage);
    
    return taskId;
  }

  emitProgress(taskId, progress, message, options = {}) {
    let actualTaskId = taskId;
    let actualProgress = progress;
    let actualMessage = message;
    let actualOptions = options;

    // Soportar desestructuración si el primer parámetro es un objeto
    if (taskId && typeof taskId === 'object') {
      actualTaskId = taskId.taskId;
      actualProgress = taskId.progress;
      actualMessage = taskId.message || taskId.currentMessage;
      actualOptions = taskId.options || {};
    }

    const taskInfo = this.tasks.get(actualTaskId);
    if (!taskInfo) {
      console.warn(`Task ${actualTaskId} not found`);
      return;
    }
    
    // Ensure progress is between 0 and 100
    const clampedProgress = Math.max(0, Math.min(100, actualProgress));
    
    // Update task info
    taskInfo.progress = clampedProgress;
    taskInfo.message = actualMessage;
    taskInfo.lastUpdate = Date.now();
    
    // Emit progress event (con throttle para no saturar IPC)
    const progressEvent = {
      taskId: actualTaskId,
      module: taskInfo.module,
      domain: taskInfo.domain,
      progress: clampedProgress,
      message: actualMessage,
      timestamp: Date.now()
    };
    
    // Siempre emitimos eventos específicos (task y módulo) porque no son muchos
    this.emit(`progress:${actualTaskId}`, progressEvent);
    this.emit(`progress:${taskInfo.module}`, progressEvent);
    
    // Evento genérico 'progress' va con throttle — es el que viaja por IPC al frontend
    if (this._throttleAllowed()) {
      this.emit('progress', progressEvent);
    }
    
    // Control de throttling para console.log de progreso
    let shouldLog = true;
    if (actualOptions && actualOptions.consoleThrottleKey) {
      const key = actualOptions.consoleThrottleKey;
      const throttleMs = actualOptions.consoleThrottleMs || 1000;
      const now = Date.now();
      const lastLog = this._consoleThrottleMap.get(key) || 0;
      if (now - lastLog < throttleMs) {
        shouldLog = false;
      } else {
        this._consoleThrottleMap.set(key, now);
      }
    }

    if (shouldLog) {
      console.log(`Progress: ${taskInfo.module} - ${taskInfo.domain} - ${clampedProgress}% - ${actualMessage}`);
    }
  }

  emitError(taskId, error, fatal = false) {
    const taskInfo = this.tasks.get(taskId);
    if (!taskInfo) {
      console.warn(`Task ${taskId} not found for error`);
      return;
    }
    
    const errorObj = {
      taskId,
      module: taskInfo.module,
      domain: taskInfo.domain,
      error: error.message || String(error),
      stack: error.stack,
      timestamp: Date.now(),
      fatal
    };
    
    taskInfo.errors.push(errorObj);
    
    if (fatal) {
      taskInfo.status = 'failed';
      taskInfo.endTime = Date.now();
    }
    
    this.emit('error', errorObj);
    this.emit(`error:${taskId}`, errorObj);
    
    console.error(`Error in ${taskInfo.module} - ${taskInfo.domain}:`, error);
  }

  completeTask(taskId, finalMessage = 'Task completed successfully') {
    const taskInfo = this.tasks.get(taskId);
    if (!taskInfo) {
      console.warn(`Task ${taskId} not found for completion`);
      return;
    }
    
    // Ensure progress is 100%
    this.emitProgress(taskId, 100, finalMessage);
    
    // Update task info
    taskInfo.status = 'completed';
    taskInfo.endTime = Date.now();
    taskInfo.duration = taskInfo.endTime - taskInfo.startTime;
    
    const completionEvent = {
      taskId,
      module: taskInfo.module,
      domain: taskInfo.domain,
      progress: 100,
      message: finalMessage,
      status: 'completed',
      duration: taskInfo.duration,
      errors: taskInfo.errors,
      timestamp: Date.now()
    };
    
    this.emit('complete', completionEvent);
    this.emit(`complete:${taskId}`, completionEvent);
    
    console.log(`Task completed: ${taskInfo.module} - ${taskInfo.domain} - ${taskInfo.duration}ms`);
    
    // Clean up task after a delay (keep for potential queries)
    setTimeout(() => {
      this.tasks.delete(taskId);
    }, 300000); // 5 minutes
    
    return completionEvent;
  }

  cancelTask(taskId, reason = 'Task cancelled by user') {
    const taskInfo = this.tasks.get(taskId);
    if (!taskInfo) {
      console.warn(`Task ${taskId} not found for cancellation`);
      return;
    }
    
    taskInfo.status = 'cancelled';
    taskInfo.endTime = Date.now();
    taskInfo.duration = taskInfo.endTime - taskInfo.startTime;
    
    const cancellationEvent = {
      taskId,
      module: taskInfo.module,
      domain: taskInfo.domain,
      progress: taskInfo.progress,
      message: reason,
      status: 'cancelled',
      duration: taskInfo.duration,
      errors: taskInfo.errors,
      timestamp: Date.now()
    };
    
    this.emit('cancel', cancellationEvent);
    this.emit(`cancel:${taskId}`, cancellationEvent);
    
    console.log(`Task cancelled: ${taskInfo.module} - ${taskInfo.domain} - ${reason}`);
    
    // Clean up task
    setTimeout(() => {
      this.tasks.delete(taskId);
    }, 300000); // 5 minutes
    
    return cancellationEvent;
  }

  getTaskInfo(taskId) {
    return this.tasks.get(taskId);
  }

  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  getActiveTasks() {
    return Array.from(this.tasks.values()).filter(task => 
      task.status === 'running'
    );
  }

  getTaskHistory(limit = 50) {
    const allTasks = Array.from(this.tasks.values());
    return allTasks
      .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
      .slice(0, limit);
  }

  // Helper method for common progress patterns
  createProgressTracker(taskId, totalSteps) {
    let currentStep = 0;
    
    return {
      step: (message, stepIncrement = 1) => {
        currentStep += stepIncrement;
        const progress = Math.min(100, Math.round((currentStep / totalSteps) * 100));
        this.emitProgress(taskId, progress, message);
      },
      setProgress: (progress, message) => {
        this.emitProgress(taskId, progress, message);
      },
      error: (error, fatal = false) => {
        this.emitError(taskId, error, fatal);
      },
      complete: (message) => {
        this.completeTask(taskId, message);
      }
    };
  }

  // Integration with Electron IPC
  setupIpcForwarding(ipcMain, mainWindow) {
    // NOTA: El forwarding de 'progress' events se hace desde los handlers
    // individuales (extraction.ipc, ssl.ipc, etc.) y module-exec.ipc.js.
    // Acá solo exponemos handlers de consulta para el renderer.
    
    ipcMain.handle('progress-get-tasks', () => {
      return this.getAllTasks();
    });
    
    ipcMain.handle('progress-get-task', (event, taskId) => {
      return this.getTaskInfo(taskId);
    });
    
    ipcMain.handle('progress-get-active', () => {
      return this.getActiveTasks();
    });
    
    ipcMain.handle('progress-get-history', (event, limit) => {
      return this.getTaskHistory(limit);
    });
  }
}

// Singleton instance
let instance = null;

function getProgressEmitter() {
  if (!instance) {
    instance = new ProgressEmitter();
  }
  return instance;
}

module.exports = { ProgressEmitter, getProgressEmitter };