// Первым: настройка zod под строгий CSP (без new Function).
import './zod-jitless.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@idb-stories/web-player/styles.css';
import './styles/app.css';
import { App } from './App.js';

const container = document.getElementById('root');
if (!container) throw new Error('Не найден контейнер #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
