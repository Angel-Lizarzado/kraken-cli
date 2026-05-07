import { create } from 'zustand';

// ── Const types (REQUIRED per typescript-strict) ──
export const ACTIVE_MODULE = {
  DASHBOARD: 'dashboard',
  EXTRACTION: 'extraction',
  DEPLOYMENT: 'deployment',
  DNS: 'dns',
  SSL: 'ssl',
} as const;

export type ActiveModule = (typeof ACTIVE_MODULE)[keyof typeof ACTIVE_MODULE];

// ── Store interface ──
interface UIState {
  // Navigation
  activeModule: ActiveModule;
  sidebarOpen: boolean;
  // Actions
  setModule: (m: ActiveModule) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

// ── Store creation ──
export const useUIStore = create<UIState>((set) => ({
  activeModule: 'dashboard',
  sidebarOpen: true,
  setModule: (m) => set({ activeModule: m }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
}));
