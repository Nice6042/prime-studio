export function ResidentBindingRecovery({ reason, pending, onRetry, onRollback }: {
  readonly reason: string;
  readonly pending: boolean;
  readonly onRetry: () => void;
  readonly onRollback: () => void;
}) {
  return <section className="resident-binding-recovery" role="alert" aria-label="Resident binding recovery">
    <div><strong>Harness session not bound</strong><p>{reason}</p></div>
    <div className="resident-binding-recovery-actions">
      <button type="button" className="btn btn-send" disabled={pending} onClick={onRetry}>Retry resident binding</button>
      <button type="button" className="btn" disabled={pending} onClick={onRollback}>Remove unbound chat</button>
    </div>
  </section>;
}
