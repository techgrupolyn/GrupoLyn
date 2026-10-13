import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ClubSsoLogin from './ceo-dashboard/ClubSsoLogin.jsx';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      {new URLSearchParams(window.location.search).get('club_sso') === '1' ? <ClubSsoLogin /> : <App />}
    </ErrorBoundary>
  </StrictMode>
);
