export const DAEMON_PROTOCOL_INFO = Object.freeze({
  name: "prime-agent.daemon",
  version: 7
});

export class DaemonClient {}
export class DaemonAgentConnection {}
export class AuthStorage {}
export class ModelRegistry {}
export function defaultDaemonSocketPath() { return "fake-daemon.sock"; }
