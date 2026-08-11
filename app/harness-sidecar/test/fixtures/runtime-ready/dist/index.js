export const DAEMON_PROTOCOL = Object.freeze({
  name: "prime-agent.daemon",
  version: 7,
  schemaRevision: 13,
  schemaId: "protocol-7-schema-13-test",
  capabilities: Object.freeze([
    "attach_snapshot",
    "event_sequence",
    "resident_sessions",
    "session_input_admission",
    "model_catalog"
  ])
});
