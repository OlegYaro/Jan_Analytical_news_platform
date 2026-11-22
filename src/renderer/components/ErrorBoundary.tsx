import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { t } from '../strings.ts';

interface State {
  error: Error | null;
}

/** Не даёт окну стать белым: при сбое интерфейса показывает понятное сообщение и кнопку перезагрузки. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Сбой интерфейса:', error.message, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal">
        <h1>{t.extra.fatalTitle}</h1>
        <p>{t.extra.fatalText}</p>
        <p className="muted">{this.state.error.message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          {t.extra.reload}
        </button>
      </div>
    );
  }
}
