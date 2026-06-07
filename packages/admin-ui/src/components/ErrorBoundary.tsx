'use client';

import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Error in ErrorBoundary:', error, errorInfo);
  }

  retry = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '20px',
          textAlign: 'center',
          background: 'var(--bg-card)',
          color: 'var(--ink)'
        }}>
          <h2>Page Error</h2>
          <p>We're sorry, there was an error loading this page.</p>
          <div>API Health: Checking...</div>
          <div style={{ color: 'var(--warn)' }}>
            Last Error: {this.state.error?.message}
          </div>
          <button
            onClick={this.retry}
            className="btn btn-sm btn-primary"
          >
            Retry
          </button>
          <div>Tenant/Company: <span>—</span></div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
