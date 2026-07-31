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
      className="fixed inset-0 flex items-center justify-center z-50 bg-black/60 backdrop-blur-sm"
    >
      <div
        className="w-full max-w-md mx-4 rounded-xl overflow-hidden bg-surface-container border border-outline-variant shadow-2xl"
      >
        <div className="px-6 py-4 border-b border-outline-variant">
          <h3 className="font-display text-lg font-bold">Confirmar apagado</h3>
        </div>
        <div className="p-6 space-y-4">
          <p className="text-sm text-on-surface-variant">
            Está por apagar <strong>{serverName}</strong>. Esta acción detendrá todos los servicios del servidor.
          </p>
          <div
            className="p-3 rounded-md text-sm bg-error/10 border border-error/20 text-error"
          >
            <div className="font-semibold mb-1">ADVERTENCIA CRÍTICA</div>
            <div className="text-xs text-on-surface-variant">
              Escriba <code className="font-mono rounded px-1 bg-black/30">APAGAR</code> para confirmar.
            </div>
          </div>
          <input
            type="text"
            value={confirmInput}
            onChange={(e) => setConfirmInput(e.target.value)}
            placeholder="Escriba APAGAR para confirmar"
            className="w-full bg-background border border-outline-variant rounded px-3 py-2 text-sm text-center text-on-surface font-mono focus:border-tertiary focus:ring-1 focus:ring-tertiary transition-all"
          />
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-outline-variant">
          <button onClick={onCancel} className="px-4 py-2 bg-surface-container border border-outline-variant text-on-surface rounded font-title-sm hover:bg-surface-container-high transition-all active:scale-95 disabled:opacity-50">
            Cancelar
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirmInput.toUpperCase() !== 'APAGAR'}
            className="px-4 py-2 bg-error text-white rounded font-title-sm hover:brightness-110 transition-all active:scale-95 disabled:opacity-50"
          >
            Confirmar apagado
          </button>
        </div>
      </div>
    </div>
  );
}
