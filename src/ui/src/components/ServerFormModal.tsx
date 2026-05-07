import React, { useState, useEffect, useRef } from 'react';

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
  testConnection: (creds: SshCredentials) => Promise<{ success: boolean; connected: boolean; error?: string }>;
  onInjectKey: (creds: SshCredentials, password: string) => Promise<{ success: boolean; error?: string }>;
  onLog: (message: string, type: 'info' | 'warning' | 'error' | 'success') => void;
  publicKeyPath?: string;
}

const AUTH_ERROR_SUBSTRING = 'All configured authentication methods failed';

const defaultForm: FormData = {
  name: '',
  host: '',
  port: 22,
  username: '',
  associatedAccount: '',
};

const ServerFormModal: React.FC<ServerFormModalProps> = ({
  isOpen, onClose, targetType, editData, accounts, servers, onSave, testConnection, onInjectKey, onLog, publicKeyPath
}) => {
  const [form, setForm] = useState<FormData>(defaultForm);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ connected: boolean; error?: string } | null>(null);
  const [saving, setSaving] = useState(false);

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
        const isAuthError = result.error && result.error.includes(AUTH_ERROR_SUBSTRING);
        if (isAuthError) {
          setShowInjectPrompt(true);
          onLog(`Autenticación fallida para ${form.host}. Use "Inyectar Llave SSH" para resolver.`, 'warning');
        } else {
          onLog(`Prueba de conexión fallida para ${form.host}: ${result.error || 'Error desconocido'}`, 'warning');
        }
      }
    } catch (err: any) {
      setTestResult({ connected: false, error: err.message });
      const isAuthError = err.message && err.message.includes(AUTH_ERROR_SUBSTRING);
      if (isAuthError) setShowInjectPrompt(true);
      onLog(`Error de conexión para ${form.host}: ${err.message}`, 'error');
    } finally {
      setTesting(false);
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
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'oklch(0 0 0 / 0.6)' }}
    >
      <div
        className="w-full max-w-lg mx-4 rounded-xl overflow-hidden"
        style={{
          maxHeight: '90vh',
          backgroundColor: 'var(--surface-raised)',
          border: '1px solid var(--border-hover)',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
        }}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderBottomColor: 'var(--border-default)' }}>
          <h2 className="font-display text-lg font-bold">
            {editData ? 'Editar' : 'Agregar'} {targetType === 'server' ? 'Servidor' : 'Cloud'}
          </h2>
          <button onClick={onClose} className="btn btn--ghost p-1.5" aria-label="Cerrar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 130px)' }}>
          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Nombre</label>
            <input
              type="text"
              value={form.name}
              onChange={e => handleChange('name', e.target.value)}
              placeholder={targetType === 'server' ? 'Plesk Producción' : 'Hostinger'}
              className="input"
            />
          </div>

          {targetType === 'cloud' && (
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                Cuenta <span style={{ color: 'var(--color-error)' }}>*</span>
              </label>
              <input
                type="text"
                value={form.associatedAccount}
                onChange={e => handleChange('associatedAccount', e.target.value)}
                placeholder="Nombre de la cuenta (nueva o existente)"
                className="input"
                list="cloud-accounts"
              />
              <datalist id="cloud-accounts">
                {(accounts || []).map(acc => (
                  <option key={acc.name} value={acc.name} />
                ))}
              </datalist>
              {targetType === 'cloud' && !form.associatedAccount && (
                <p className="mt-1 text-xs" style={{ color: 'var(--color-warning)' }}>
                  Ingrese el nombre de la cuenta para asociar el cloud.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Host</label>
              <input
                type="text"
                value={form.host}
                onChange={e => handleChange('host', e.target.value)}
                placeholder="192.168.1.100"
                className="input input--mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Puerto</label>
              {targetType === 'cloud' ? (
                <div
                  className="input input--mono flex items-center"
                  style={{ color: 'var(--text-muted)', cursor: 'not-allowed' }}
                >
                  65002
                </div>
              ) : (
                <input
                  type="number"
                  value={form.port}
                  onChange={e => handleChange('port', parseInt(e.target.value) || 22)}
                  className="input input--mono"
                />
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>Usuario SSH</label>
            <input
              type="text"
              value={form.username}
              onChange={e => handleChange('username', e.target.value)}
              placeholder="root"
              className="input input--mono"
            />
          </div>

          {testResult && (
            <div
              className="p-3 rounded-md text-sm"
              style={{
                backgroundColor: testResult.connected
                  ? 'oklch(0.5 0.15 150 / 0.15)'
                  : 'oklch(0.45 0.18 25 / 0.15)',
                border: `1px solid ${
                  testResult.connected
                    ? 'oklch(0.5 0.15 150 / 0.25)'
                    : 'oklch(0.45 0.18 25 / 0.25)'
                }`,
                color: testResult.connected ? 'var(--color-success)' : 'var(--color-error)',
              }}
            >
              <div className="font-medium">
                {testResult.connected ? 'Conexión exitosa' : 'Conexión fallida'}
              </div>
              {testResult.error && (
                <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>{testResult.error}</div>
              )}
            </div>
          )}

          {showInjectPrompt && !injectResult?.success && (
            <div
              className="p-4 rounded-md space-y-3"
              style={{
                backgroundColor: 'oklch(0.55 0.15 75 / 0.12)',
                border: '1px solid oklch(0.55 0.15 75 / 0.25)',
              }}
            >
              <div className="flex items-center gap-2 text-sm font-medium" style={{ color: 'var(--color-warning)' }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
                </svg>
                Autenticación SSH fallida
              </div>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                Inyecte su llave pública SSH en el servidor para habilitar el acceso sin contraseña.
                Se usará <code className="font-mono rounded px-1" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>{publicKeyPath || '~/.ssh/id_rsa.pub'}</code>
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={rootPassword}
                  onChange={e => setRootPassword(e.target.value)}
                  placeholder="Contraseña root (no se guarda)"
                  className="input input--mono flex-1"
                />
                <button
                  onClick={handleInjectKey}
                  disabled={injecting || !rootPassword}
                  className="btn text-xs whitespace-nowrap"
                  style={{
                    backgroundColor: 'oklch(0.5 0.15 150 / 0.2)',
                    color: 'var(--color-success)',
                    border: '1px solid oklch(0.5 0.15 150 / 0.3)',
                  }}
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
                <div className="text-xs" style={{ color: 'var(--color-error)' }}>
                  Error: {injectResult.error}
                </div>
              )}
            </div>
          )}

          {injectResult?.success && (
            <div
              className="p-3 rounded-md text-sm"
              style={{
                backgroundColor: 'oklch(0.5 0.15 150 / 0.15)',
                border: '1px solid oklch(0.5 0.15 150 / 0.25)',
                color: 'var(--color-success)',
              }}
            >
              <div className="font-medium">Llave SSH inyectada exitosamente</div>
              <div className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                El servidor ahora acepta su llave pública. Conexión habilitada.
              </div>
            </div>
          )}

          {testResult?.connected === false && !showInjectPrompt && (
            <div
              className="p-3 rounded-md text-sm"
              style={{
                backgroundColor: 'oklch(0.55 0.15 75 / 0.12)',
                border: '1px solid oklch(0.55 0.15 75 / 0.2)',
                color: 'var(--color-warning)',
              }}
            >
              No se detectó acceso SSH. Si guarda, el enlace SSH deberá realizarse manualmente más adelante.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderTopColor: 'var(--border-default)' }}>
          <button
            onClick={handleTestConnection}
            disabled={testing || !form.host || !form.username}
            className="btn btn--secondary text-xs"
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
            <button onClick={onClose} className="btn btn--secondary">
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
              className="btn btn--primary"
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
