import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { t } from './strings.ts';
import './styles.css';

const root = document.getElementById('root')!;

// Если ошибка случилась вне React — всё равно не оставляем белый экран.
function showFatal(msg: string): void {
  if (root.childElementCount > 0) return;
  root.textContent = `${t.extra.fatalTitle}. ${t.extra.fatalText} (${msg})`;
}
window.addEventListener('error', (e) => showFatal(e.message));
window.addEventListener('unhandledrejection', (e) => console.error('Необработанная ошибка:', String(e.reason)));

createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
