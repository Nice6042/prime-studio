import { useEffect, useState } from "react";
import * as rpc from "../rpc";
import type { CliStatus } from "../types";
import { PRIME_AGENT_URL } from "./primeAgent";

export { PRIME_AGENT_URL } from "./primeAgent";

/**
 * Where prime-agent lives. Everything the app does needs this one path, so it is
 * the only setting that exists — anything else belongs in prime's own config.
 *
 * "Detect" clears the saved path, which drops the backend back to its layered
 * autodetection (PATH, then the per-OS default install locations).
 */
export function CliSettings({
  status,
  onStatus,
}: {
  status: CliStatus | null;
  /** Resolution changed — the caller re-renders its banner and reloads models. */
  onStatus: (s: CliStatus) => void;
}) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  // `node <cli> --version` is a real spawn, so it runs once per resolved path
  // rather than on every render. A failure is left to the Check button to explain.
  useEffect(() => {
    setVersion(null);
    if (!status?.path) return;
    let alive = true;
    rpc
      .checkPrimeCli(null)
      .then((v) => alive && setVersion(v))
      .catch(() => alive && setVersion(null));
    return () => {
      alive = false;
    };
  }, [status?.path]);

  // Seed the box from whatever is configured, or the auto-detected path so the
  // user can see and edit the real value instead of an empty field.
  useEffect(() => {
    setDraft(status?.configured ?? status?.path ?? "");
  }, [status?.configured, status?.path]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNote("");
    try {
      setNote(await fn());
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (path: string | null) =>
    run(async () => {
      const next = await rpc.setPrimeCli(path);
      onStatus(next);
      return next.error ?? `Using ${next.path} (${next.source})`;
    });

  const check = () =>
    run(async () => `prime-agent ${await rpc.checkPrimeCli(draft.trim() || null)}`);

  return (
    <section className="acct-group">
      <h3>Prime agent CLI</h3>
      {status?.path ? (
        <div className="muted small pad">
          Found <code>{status.path}</code> via {status.source}.
          {status.shim ? " Console-hide shim present." : ""}
          {version ? ` Version ${version}.` : ""}
        </div>
      ) : (
        <>
          <div className="empty-state">
            <strong>prime-agent not found.</strong> Prime Studio is a client for it — no chat, no
            model list and no login until it resolves. Install it, or point the box below at its{" "}
            <code>dist</code> directory. Everything that was tried:
          </div>
          <pre className="cli-error">{status?.error ?? "Resolving…"}</pre>
        </>
      )}

      <div className="acct-actions">
        <input
          className="search acct-edit cli-input"
          placeholder="Path to prime-agent's dist, or its bundle/cli.js"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void save(draft.trim() || null)}
        />
        <button className="btn" disabled={busy} onClick={() => void save(draft.trim() || null)}>
          Save
        </button>
        <button
          className="btn"
          disabled={busy}
          title="Clear the saved path and auto-detect again"
          onClick={() => void save(null)}
        >
          Detect
        </button>
        <button className="btn" disabled={busy} onClick={() => void check()}>
          Check
        </button>
        <button className="btn" onClick={() => void rpc.openExternal(PRIME_AGENT_URL)}>
          Install instructions
        </button>
      </div>

      {status?.path && (
        <p className="muted small">
          {status.daemon ? (
            <>
              <strong>Daemon-backed sessions: supported.</strong> Agents outlive their tab and the
              app — closing a tab detaches, and Fleet lists everything still running.
            </>
          ) : (
            <>
              <strong>Daemon-backed sessions: not supported by this build.</strong> Sessions belong
              to the window that started them and end when their tab closes, so there is no Fleet
              and no reattach. Detected by asking this binary for its <code>--help</code>: it
              offers no <code>-d, --background</code>.
            </>
          )}
          {status.daemonSocket ? ` Daemon socket: ${status.daemonSocket}.` : ""}
        </p>
      )}

      {note && <div className="muted small pad">{note}</div>}
      <p className="muted small">
        Resolution order: this setting, then the <code>PRIME_STUDIO_CLI</code> /{" "}
        <code>PRIME_AGENT_CLI</code> environment variables, then <code>prime-agent</code> on
        PATH, then the per-OS default install locations.
      </p>
    </section>
  );
}
