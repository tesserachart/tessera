import { Button } from '@tessera/ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from './telemetry.ts';

export interface ErrorBoundaryProps {
  name: string;
  className?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[${this.props.name}] stopped working`, error, info.componentStack);
    reportError(error, { kind: 'render', place: this.props.name, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`tile tile-stopped ${this.props.className ?? ''}`.trim()} role="alert">
        <div className="tile-empty">
          <b>{this.props.name} stopped working.</b>{' '}
          <span className="tile-stopped-msg" data-selectable>
            {error.message}
          </span>
        </div>
        <div className="tile-stopped-actions">
          <Button size="s" onClick={() => this.setState({ error: null })}>
            Reload {this.props.name.toLowerCase()}
          </Button>
        </div>
      </div>
    );
  }
}
