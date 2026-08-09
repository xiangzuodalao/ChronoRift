import { EventEmitter } from "node:events";

import { EnvHttpProxyAgent, install, setGlobalDispatcher } from "undici";

const DEFAULT_HOST_HTTP_IDLE_TIMEOUT_MS = 300_000;

export interface VNextPiHostHttpTransportDependencies {
  readonly installProxyDispatcher: () => void;
}

const hasValue = (value: string | undefined): boolean =>
  value !== undefined && value.trim().length > 0;

export const hasVNextPiHostHttpProxy = (
  environment: Readonly<NodeJS.ProcessEnv>,
): boolean =>
  hasValue(environment.https_proxy) ||
  hasValue(environment.HTTPS_PROXY) ||
  hasValue(environment.http_proxy) ||
  hasValue(environment.HTTP_PROXY);

const ignoreDispatcherError = (): void => undefined;

const installProxyDispatcher = (): void => {
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: DEFAULT_HOST_HTTP_IDLE_TIMEOUT_MS,
    headersTimeout: DEFAULT_HOST_HTTP_IDLE_TIMEOUT_MS,
  });
  if (dispatcher instanceof EventEmitter) {
    EventEmitter.prototype.on.call(dispatcher, "error", ignoreDispatcherError);
  }
  setGlobalDispatcher(dispatcher);
  install();
};

export const createVNextPiHostHttpTransportConfigurer = (
  dependencies: VNextPiHostHttpTransportDependencies = {
    installProxyDispatcher,
  },
): ((environment: Readonly<NodeJS.ProcessEnv>) => boolean) => {
  let configured = false;
  return (environment): boolean => {
    if (!hasVNextPiHostHttpProxy(environment)) return false;
    if (configured) return true;
    dependencies.installProxyDispatcher();
    configured = true;
    return true;
  };
};

const configureDefaultTransport = createVNextPiHostHttpTransportConfigurer();

export const configureVNextPiHostHttpTransport = (): boolean =>
  configureDefaultTransport(process.env);
