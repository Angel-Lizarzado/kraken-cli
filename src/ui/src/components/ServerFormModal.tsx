import React, { useState, useEffect, useRef } from 'react';
import { useToast } from './Toast';

interface SshCredentials {
  host: string;
  port: number;
  username: string;
}

interface FormData {
  name: string;
  host: string;
  port: number;
  username: string;
  associatedAccount: string;
}

interface ServerFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetType: 'server' | 'cloud';
  editData?: {
    accountName?: string;
    itemName: string;
  };
  accounts?: Array<{ name: string }>;
  servers?: Array<any>;
  onSave: (configPayload: any) => Promise<boolean>;
  onDelete?: () => void;
  testConnection: (creds: SshCredentials) => Promise<{ success: boolean; connected: boolean; error?: string }>;
  onInjectKey: (creds: SshCredentials, password: string) => Promise<{ success: boolean; error?: string }>;
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
  publicKeyPath?: string;
}

const AUTH_ERROR_SUBSTRINGS = [
  'All configured authentication methods failed',
  'ECONNRESET',
  'ECONNABORTED',
  'Handshake failed',
  'Timeout while waiting for handshake'
];

const defaultForm: FormData = {
  name: '',
  host: '',
  port: 22,
  username: '',
  associatedAccount: '',
};

const ServerFormModal: React.FC<ServerFormModalProps> = ({
  isOpen, onClose, targetType, editData, accounts, servers, onSave, onDelete, testConnection, onInjectKey, onLog, publicKeyPath
}) => {
  const toast = useToast();
  const [form, setForm] = useState<FormData>(defaultForm);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [resolvingIp, setResolvingIp] = useState(false);

  // Injection state
  const [showInjectPrompt, setShowInjectPrompt] = useState(false);
  const [rootPassword, setRootPassword] = useState('');
  const [injecting, setInjecting] = useState(false);
  const [injectResult, setInjectResult] = useState<{ success: boolean; error?: string } | null>(null);
  const forceConnectedRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      if (editData) {
        let item: any = null;
        if (targetType === 'server') {
          item = servers?.find((s: any) => s.name === editData.itemName);
        } else {
          const account = accounts?.find(a => a.name === editData.accountName);
          if (account) {
            item = (account as any).originClouds?.find((c: any) => c.name === editData.itemName);
          }
        }
        if (item) {
          setForm({
            name: item.name || '',
            host: item.sshCredentials?.host || '',
            port: item.sshCredentials?.port || (targetType === 'cloud' ? 65002 : 22),
            username: item.sshCredentials?.username || '',
            associatedAccount: editData.accountName || (targetType === 'cloud' ? '' : ''),
          });
        }
      } else {
        const port = targetType === 'cloud' ? 65002 : 22;
        setForm({ ...defaultForm, port });
      }
      setTestResult(null);
      setTesting(false);
      setSaving(false);
      setShowInjectPrompt(false);
      setRootPassword('');
      setInjectResult(null);
    }
  }, [isOpen, targetType, editData, accounts]);

  const handleChange = (field: keyof FormData, value: string | number) => {
    setForm(prev => ({ ...prev, [field]: value }));
    setTestResult(null);
    setInjectResult(null);
    forceConnectedRef.current = false;
  };

  const buildCredentials = (): SshCredentials => ({
    host: form.host,
    port: form.port,
    username: form.username,
  });

  const handleTestConnection = async () => {
    if (!form.host || !form.username) return;

    setTesting(true);
    setTestResult(null);
    setInjectResult(null);
    setShowInjectPrompt(false);

    try {
      const result = await testConnection(buildCredentials());
      setTestResult({
        connected: result.connected,
        error: result.error,
      });
      if (result.connected) {
        onLog(`Prueba de conexión exitosa para ${form.host}`, 'success');
      } else {
        const isAuthError = result.error && AUTH_ERROR_SUBSTRINGS.some(s => result.error!.includes(s));
        if (isAuthError) {
          setShowInjectPrompt(true);
          onLog(`Autenticación fallida para ${form.host}. Use "Inyectar Llave SSH" para resolver.`, 'warning');
        } else {
          onLog(`Prueba de conexión fallida para ${form.host}: ${result.error || 'Error desconocido'}`, 'warning');
        }
      }
    } catch (err: any) {
      setTestResult({ connected: false, error: err.message });
      const isAuthError = err.message && AUTH_ERROR_SUBSTRINGS.some(s => err.message.includes(s));
      if (isAuthError) setShowInjectPrompt(true);
      onLog(`Error de conexión para ${form.host}: ${err.message}`, 'error');
    } finally {
      setTesting(false);
    }
  };

  const handleResolveIp = async () => {
    const api = (window as any).api;
    if (!api || !form.host) return;
    setResolvingIp(true);

    // Extraer puerto si el usuario lo pegó en el campo de host (ej: dominio.com:8443)
    let extractedPort: number | null = null;
    const matchPort = form.host.match(/:(\d+)$/);
    if (matchPort) {
      extractedPort = parseInt(matchPort[1], 10);
    }

    try {
      const result = await api.invoke('server:resolve-ip', { host: form.host });
      if (result.success && result.ip) {
        if (extractedPort) {
          handleChange('port', extractedPort);
          toast.info(`Puerto ${extractedPort} detectado y extraído automáticamente.`);
        }

        if (result.ip === form.host) {
          toast.info(`El host ya es una IP: ${result.ip}`);
          onLog(`El host ya es una IP: ${result.ip}`, 'info');
        } else {
          handleChange('host', result.ip);
          toast.success(`Dominio resuelto a IP: ${result.ip}`);
          onLog(`Dominio resuelto a IP: ${result.ip}`, 'success');
        }
      } else {
        toast.error(`No se pudo resolver la IP: ${result.error}`);
        onLog(`No se pudo resolver la IP: ${result.error}`, 'warning');
      }
    } catch (err: any) {
      toast.error(`Error al resolver IP: ${err.message}`);
      onLog(`Error al resolver IP: ${err.message}`, 'error');
    } finally {
      setResolvingIp(false);
    }
  };

  const handleInjectKey = async () => {
    if (!rootPassword) return;

    setInjecting(true);
    setInjectResult(null);

    try {
      const result = await onInjectKey(buildCredentials(), rootPassword);
      if (result.success) {
        setInjectResult({ success: true });
        setShowInjectPrompt(false);
        setRootPassword('');
        onLog(`Llave SSH inyectada exitosamente en ${form.host}`, 'success');
        forceConnectedRef.current = true;
        await new Promise(r => setTimeout(r, 500));
        handleSave();
      } else {
        setInjectResult({ success: false, error: result.error });
        onLog(`Error al inyectar llave SSH: ${result.error}`, 'error');
      }
    } catch (err: any) {
      setInjectResult({ success: false, error: err.message });
      onLog(`Error al inyectar llave SSH: ${err.message}`, 'error');
    } finally {
      setInjecting(false);
    }
  };

  const handleSave = async () => {
    if (!form.name || !form.host || !form.username) return;
    if (targetType === 'cloud' && !form.associatedAccount) return;

    setSaving(true);

    let connected = forceConnectedRef.current ? true : testResult?.connected;
    let connError = forceConnectedRef.current ? undefined : testResult?.error;
    forceConnectedRef.current = false;

    if (connected === undefined) {
      try {
        const result = await testConnection(buildCredentials());
        connected = result.connected;
        connError = result.error;
        if (result.connected) {
          onLog(`Conexión preexistente detectada para ${form.host}. Enlace automático completado.`, 'success');
        }
      } catch (err: any) {
        connected = false;
        connError = err.message;
      }
    }

    if (connected) {
      onLog(`Conexión verificada para ${form.host}. Enlace SSH completado.`, 'success');
    } else {
      onLog(`Se requiere enlace manual para ${form.host}.`, 'warning');
    }

    const payload = {
      targetType,
      formData: { ...form },
      isLinked: !!connected,
      connectionError: connError,
      editData: editData || null,
    };

    try {
      const saved = await onSave(payload);
      if (saved) {
        onClose();
      }
    } catch (err: any) {
      onLog(`Error al guardar: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-[100] bg-black/60 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-lg mx-4 rounded-xl overflow-hidden bg-surface-container border border-outline-variant shadow-2xl max-h-[90vh]"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-outline-variant">
          <h2 className="font-display text-lg font-bold">
            {editData ? 'Editar' : 'Agregar'} {targetType === 'server' ? 'Servidor' : 'Cloud'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-all" aria-label="Cerrar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 130px)' }}>
          <div>
            <label className="block text-sm font-medium mb-1.5 text-on-surface-variant">Nombre</label>
            <input
              type="text"
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder={targetType === 'server' ? 'Plesk Producción' : 'Hostinger'}
              className="w-full bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
            />
          </div>

          {targetType === 'cloud' && (
            <div>
              <label className="block text-sm font-medium mb-1.5 text-on-surface-variant">
                Cuenta <span className="text-error">*</span>
              </label>
              <input
                type="text"
                value={form.associatedAccount}
                onChange={e => handleChange('associatedAccount', e.target.value)}
                placeholder="Nombre de la cuenta (nueva o existente)"
                className="w-full bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
                list="cloud-accounts"
              />
              <datalist id="cloud-accounts">
                {(accounts || []).map(acc => (
                  <option key={acc.name} value={acc.name} />
                ))}
              </datalist>
              {targetType === 'cloud' && !form.associatedAccount && (
                <p className="mt-1 text-xs text-yellow-400">
                  Ingrese el nombre de la cuenta para asociar el cloud.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1.5 text-on-surface-variant">Host</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={form.host}
                  onChange={e => handleChange('host', e.target.value)}
                  placeholder="192.168.1.100 o dominio.com"
                  className="w-full flex-1 bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface font-mono focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
                />
                <button
                  onClick={handleResolveIp}
                  disabled={resolvingIp || !form.host}
                  className="px-3 py-1.5 bg-surface-container border border-outline-variant text-on-surface rounded font-title-sm text-xs hover:bg-surface-container-high transition-all active:scale-95 disabled:opacity-50"
                  title="Resolver dominio a IP"
                  style={{ padding: '0 12px' }}
                >
                  {resolvingIp ? <span className="spinner" /> : 'Resolver IP'}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5 text-on-surface-variant">Puerto</label>
              {targetType === 'cloud' ? (
                <div
                  className="w-full flex items-center bg-background border border-outline-variant rounded px-3 py-1.5 text-sm font-mono opacity-60 cursor-not-allowed"
                  
                >
                  65002
                </div>
              ) : (
                <input
                  type="number"
                  value={form.port}
                  onChange={e => handleChange('port', parseInt(e.target.value) || 22)}
                  className="w-full bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface font-mono focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
                />
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5 text-on-surface-variant">Usuario SSH</label>
            <input
              type="text"
              value={form.username}
              onChange={e => handleChange('username', e.target.value)}
              placeholder="root"
              className="w-full bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface font-mono focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
            />
          </div>

          {testResult && (
            <div
              className="p-3 rounded-md text-sm"
              style={{
                backgroundColor: testResult.connected ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                borderColor: testResult.connected ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                color: testResult.connected ? '#22c55e' : '#ef4444',
              }}
            >
              <div className="font-medium">
                {testResult.connected ? 'Conexión exitosa' : 'Conexión fallida'}
              </div>
              {testResult.error && (
                <div className="mt-1 text-xs text-on-surface-variant">{testResult.error}</div>
              )}
            </div>
          )}

          {showInjectPrompt && !injectResult?.success && (
            <div
              className="p-4 rounded-md space-y-3 bg-yellow-500/10 border border-yellow-500/20"
            >
              <div className="flex items-center gap-2 text-sm font-medium text-yellow-400">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                Autenticación SSH fallida
              </div>
              <p className="text-xs text-on-surface-variant">
                Inyecte su llave pública SSH en el servidor para habilitar el acceso sin contraseña.
                Se usará <code className="font-mono rounded px-1" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>{publicKeyPath || '~/.ssh/id_rsa.pub'}</code>
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={rootPassword}
                  onChange={e => setRootPassword(e.target.value)}
                  placeholder="Contraseña root (no se guarda)"
                  className="w-full flex-1 bg-background border border-outline-variant rounded px-3 py-1.5 text-sm text-on-surface font-mono focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
                />
                <button
                  onClick={handleInjectKey}
                  disabled={injecting || !rootPassword}
                  className="px-3 py-1.5 rounded font-title-sm text-xs whitespace-nowrap bg-green-500/20 text-green-400 border border-green-500/30 hover:bg-green-500/30 transition-all active:scale-95 disabled:opacity-50"
                >
                  {injecting ? (
                    <span className="flex items-center gap-1">
                      <span className="spinner" />
                      Inyectando...
                    </span>
                  ) : (
                    'Inyectar Llave SSH'
                  )}
                </button>
              </div>
              {injectResult && !injectResult.success && (
                <div className="text-xs text-error">
                  Error: {injectResult.error}
                </div>
              )}
            </div>
          )}

          {injectResult?.success && (
            <div
              className="p-3 rounded-md text-sm bg-green-500/10 border border-green-500/20 text-green-400"
            >
              <div className="font-medium">Llave SSH inyectada exitosamente</div>
              <div className="mt-1 text-xs text-on-surface-variant">
                El servidor ahora acepta su llave pública. Conexión habilitada.
              </div>
            </div>
          )}

          {testResult?.connected === false && !showInjectPrompt && (
            <div
              className="p-3 rounded-md text-sm bg-yellow-500/10 border border-yellow-500/20 text-yellow-400"
            >
              No se detectó acceso SSH. Si guarda, el enlace SSH deberá realizarse manualmente más adelante.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t border-outline-variant">
          <button
            onClick={handleTestConnection}
            disabled={testing || !form.host || !form.username}
            className="px-3 py-1.5 bg-surface-container border border-outline-variant text-on-surface rounded font-title-sm text-xs hover:bg-surface-container-high transition-all active:scale-95 disabled:opacity-50"
          >
            {testing ? (
              <span className="flex items-center gap-2">
                <span className="spinner" />
                Probando...
              </span>
            ) : (
              'Probar conexión'
            )}
          </button>

          <div className="flex gap-3">
            {onDelete && (
              <button onClick={onDelete} className="px-3 py-1.5 text-error hover:bg-error/10 rounded font-title-sm text-xs transition-all">
                Eliminar
              </button>
            )}
            <button onClick={onClose} className="px-4 py-2 bg-surface-container border border-outline-variant text-on-surface rounded font-title-sm hover:bg-surface-container-high transition-all active:scale-95 disabled:opacity-50">
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={
                saving ||
                !form.name ||
                !form.host ||
                !form.username ||
                (targetType === 'cloud' && !form.associatedAccount)
              }
              className="px-4 py-2 bg-secondary text-on-secondary rounded font-title-sm hover:brightness-110 transition-all active:scale-95 disabled:opacity-50"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <span className="spinner" />
                  Guardando...
                </span>
              ) : (
                'Guardar'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ServerFormModal;
