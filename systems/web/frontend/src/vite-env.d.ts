/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_EXECUTION_PORT?: string;
  readonly VITE_MARKET_DATA_PORT?: string;
  readonly VITE_ACCOUNTS_PORT?: string;
  readonly VITE_SIGNAL_ENGINE_PORT?: string;
  readonly VITE_SHELL_PORT?: string;
}
