import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

// The theme class goes on before React paints, so a dark-mode user never sees a white flash.
const saved = localStorage.getItem('acr-theme');
const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark', dark);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
