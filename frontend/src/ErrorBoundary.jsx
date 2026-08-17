import { Component } from 'react';

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary capturó un error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex min-h-screen items-center justify-center bg-[#0D0D0D] px-6">
          <div className="w-full max-w-md border border-[#2E2E2E] bg-[#141414] p-10">
            <p className="text-xs uppercase tracking-[0.3em] text-[#737373]">Superagente</p>
            <h1 className="mt-3 text-2xl font-light text-[#F2F2F2]">Ocurrió un error</h1>
            <p className="mt-2 text-sm text-[#737373]">
              La interfaz tuvo un problema inesperado. Podés recargar la página o volver a intentarlo.
            </p>
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-[#737373]">Detalle técnico</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-[#737373]">
                {this.state.error?.message}
                {'\n'}
                {this.state.error?.stack}
              </pre>
            </details>
            <button
              type="button"
              onClick={() => {
                this.setState({ hasError: false, error: null });
              }}
              className="mt-6 border border-[#2E2E2E] bg-[#BFBFBF] px-4 py-2 text-xs uppercase tracking-widest text-[#000000]"
            >
              Reintentar
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
