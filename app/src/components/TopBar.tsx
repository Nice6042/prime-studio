import type { SettingsSection } from "./settingsSections";
import type { KernelStatus } from "../types";

/**
 * A compact titlebar for global identity, runtime health, and window-level actions.
 * Session-specific controls stay beside the transcript that owns them.
 */
export function TopBar({
  kernel,
  starting,
  daemon,
  account,
  onOpenSettings,
}: {
  kernel: KernelStatus | null;
  /** Prime is still spawning, so the kernel probe means nothing yet. */
  starting: boolean;
  /** Sessions survive this window only when prime is daemon-capable. */
  daemon: boolean;
  /** Which login this session is bound to — fixed for its whole life. */
  account: string;
  onOpenSettings: (section?: SettingsSection) => void;
}) {
  // Same rule as the rail's kernelLine: an interpreter without ipykernel cannot
  // run a single cell, so it is not "ready" no matter that python resolved.
  const ok = !starting && !!kernel?.exists && !!kernel.ipykernel;
  const text = starting
    ? "starting prime…"
    : !kernel
      ? "checking kernel…"
      : !kernel.exists
        ? "no interpreter — tools cannot run"
        : !kernel.ipykernel
          ? "no ipykernel — tools cannot run"
          : "kernel ready";

  return (
    <header className="titlebar">
      <div className="brand">PRIME STUDIO</div>
      <div className="spacer" />

      {/* Only claimed where it is true: on a stock prime a closed window ends the
          session, and saying DAEMON there would be a promise the build cannot keep. */}
      {daemon && (
        <span
          className="tb-flag ok"
          title="Agents run in prime's daemon: closing this window detaches, it does not stop the work."
        >
          <span className="dot" />
          DAEMON
        </span>
      )}
      <button
        className="tb-acct"
        title={`${account} — an account is fixed when a session starts. Manage accounts in Settings.`}
        onClick={() => onOpenSettings("accounts")}
      >
        {account}
      </button>

      <button
        className={`kernel-pill ${ok ? "ok" : "bad"}`}
        title={
          ok
            ? `${kernel?.python ?? "python"} — prime's only tool is this IPython kernel`
            : "Prime's only tool is the IPython kernel. Nothing runs without it — open Settings → Kernel."
        }
        onClick={() => onOpenSettings("kernel")}
      >
        <span className="dot" />
        {text}
      </button>
      <button className="btn btn-icon" onClick={() => onOpenSettings()} title="Settings (Ctrl+,)">
        ⚙
      </button>
    </header>
  );
}
