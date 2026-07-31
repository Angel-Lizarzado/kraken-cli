import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import { ConfigProvider } from './contexts/ConfigContext';
import { AppStateProvider } from './contexts/AppStateContext';
import { ErrorBoundary } from './components/ErrorBoundary';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <ConfigProvider>
        <AppStateProvider>
          <App />
        </AppStateProvider>
      </ConfigProvider>
    </ErrorBoundary>
  </React.StrictMode>
);

// If you want to start measuring performance in your app, pass a function