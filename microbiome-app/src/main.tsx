import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element found.');

createRoot(container).render(
  <StrictMode>
    {/*
      The outermost boundary. Anything that escapes a panel's own boundary
      lands here and is shown, rather than unmounting the root and leaving
      the user with a blank page and no explanation.
    */}
    <ErrorBoundary label="The application hit an unexpected error">
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
