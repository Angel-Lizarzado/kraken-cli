import { useState, useCallback } from 'react';

interface ConfirmDialogProps {
  serverName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ serverName, onConfirm, onCancel }: ConfirmDialogProps) {
  const [confirmInput, setConfirmInput] = useState('');

  const handleConfirm = useCallback(() => {
    if (confirmInput.toUpperCase() === 'APAGAR') {
      onConfirm();
    }
  }, [confirmInput, onConfirm]);

  return (
    <div
      className="fixed inset-0 flex items-center justify-center z-50"
      style={{ backgroundColor: 'oklch(0 0 0 / 0.6)' }}
    >
      <div
        className="w-full max-w-md mx-4 rounded-xl overflow-hidden"
        style={{
          backgroundColor: 'var(--surface-raised)',
          border: '1px solid var(--border-hover)',
          boxShadow: '0 25px 50px -12px rgba(0,0,0,0.6)',
        }}
      >
        <div className="px-6 py-4 border-b" style={{ borderBottomColor: 'var(--border-default)' }}>
          <h3 className="font-display text-lg font-bold">Confirmar apagado</h3>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Está por apagar <strong>{serverName}</strong>. Esta acción detendrá todos los servicios del servidor.
          </p>
          <div
            className="p-3 rounded-md text-sm"
            style={{
              backgroundColor: 'oklch(0.45 0.18 25 / 0.15)',
              border: '1px solid oklch(0.45 0.18 25 / 0.25)',
              color: 'var(--color-error)',
            }}
          >
            <div className="font-semibold mb-1">ADVERTENCIA CRÍTICA</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              Escriba <code className="font-mono rounded px-1" style={{ backgroundColor: 'oklch(0 0 0 / 0.3)' }}>APAGAR</code> para confirmar.
            </div>
          </div>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="Escriba APAGAR para confirmar"
            className="input input--mono text-center"
          />
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t" style={{ borderTopColor: 'var(--border-default)' }}>
          <button onClick={onCancel} className="btn btn--secondary">
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirmInput.toUpperCase() !== 'APAGAR'}
            className="btn btn--danger"
          >
            Confirmar apagado
          </button>
        </div>
      </div>
    </div>
  );
}
