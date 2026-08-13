import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { HarnessExtensionUiRequest } from "../../shared/ipc/client";

type ExtensionResponse = Readonly<{ confirmed: boolean }> | Readonly<{ value: string }> | Readonly<{ cancelled: true }>;

export function ExtensionPrompt({ request, autoFocus, disabled, onRespond }: {
  readonly request: HarnessExtensionUiRequest;
  readonly autoFocus: boolean;
  readonly disabled: boolean;
  readonly onRespond: (response: ExtensionResponse) => void;
}) {
  const [value, setValue] = useState(request.method === "select" ? request.options[0] ?? "" : request.method === "input" ? "" : request.method === "editor" ? request.prefill : "");
  const primaryControl = useRef<HTMLElement | null>(null);
  const priorAutoFocus = useRef<boolean | null>(null);
  const focusWhenEnabled = useRef(false);
  useLayoutEffect(() => {
    const initial = priorAutoFocus.current === null;
    if (autoFocus && (priorAutoFocus.current === false || (initial && (document.activeElement === document.body || document.activeElement === null)))) focusWhenEnabled.current = true;
    priorAutoFocus.current = autoFocus;
    if (autoFocus && !disabled && focusWhenEnabled.current) {
      primaryControl.current?.focus();
      focusWhenEnabled.current = false;
    }
  }, [autoFocus, disabled]);
  const controlId = `harness-extension-${request.id}`;
  const cancel = () => onRespond({ cancelled: true });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (request.method === "editor" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onRespond({ value });
    }
  };

  return <section className="harness-extension-prompt" aria-labelledby={`${controlId}-title`} onKeyDown={onKeyDown}>
    <div className="harness-extension-heading">
      <span>Extension request</span>
      <h2 id={`${controlId}-title`}>{request.title}</h2>
    </div>
    {request.method === "confirm" && <>
      <p>{request.message}</p>
      <div className="harness-extension-actions">
        <button ref={(node) => { primaryControl.current = node; }} type="button" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:confirm`} aria-label={`Confirm ${request.title}`} onClick={() => onRespond({ confirmed: true })}>Confirm</button>
        <button type="button" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:decline`} aria-label={`Decline ${request.title}`} onClick={() => onRespond({ confirmed: false })}>Decline</button>
        <button type="button" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:cancel`} aria-label={`Cancel ${request.title}`} onClick={cancel}>Cancel</button>
      </div>
    </>}
    {request.method === "select" && <form onSubmit={(event) => { event.preventDefault(); onRespond({ value }); }}>
      <label htmlFor={`${controlId}-select`}>{request.title}</label>
      <select ref={(node) => { primaryControl.current = node; }} id={`${controlId}-select`} data-control-id={`harness.extension.input:${request.id}`} disabled={disabled} value={value} onChange={(event) => setValue(event.target.value)}>
        {request.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      <div className="harness-extension-actions">
        <button type="submit" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:submit`} aria-label={`Submit ${request.title}`}>Submit</button>
        <button type="button" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:cancel`} aria-label={`Cancel ${request.title}`} onClick={cancel}>Cancel</button>
      </div>
    </form>}
    {request.method === "input" && <form onSubmit={(event) => { event.preventDefault(); onRespond({ value }); }}>
      <label htmlFor={`${controlId}-input`}>{request.title}</label>
      <input ref={(node) => { primaryControl.current = node; }} id={`${controlId}-input`} data-control-id={`harness.extension.input:${request.id}`} disabled={disabled} value={value} placeholder={request.placeholder ?? undefined} onChange={(event) => setValue(event.target.value)} />
      <div className="harness-extension-actions">
        <button type="submit" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:submit`} aria-label={`Submit ${request.title}`}>Submit</button>
        <button type="button" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:cancel`} aria-label={`Cancel ${request.title}`} onClick={cancel}>Cancel</button>
      </div>
    </form>}
    {request.method === "editor" && <form onSubmit={(event) => { event.preventDefault(); onRespond({ value }); }}>
      <label htmlFor={`${controlId}-editor`}>{request.title}</label>
      <textarea ref={(node) => { primaryControl.current = node; }} id={`${controlId}-editor`} data-control-id={`harness.extension.input:${request.id}`} disabled={disabled} value={value} onChange={(event) => setValue(event.target.value)} />
      <small>Submit with Ctrl+Enter. Cancel with Escape.</small>
      <div className="harness-extension-actions">
        <button type="submit" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:submit`} aria-label={`Submit ${request.title}`}>Submit</button>
        <button type="button" disabled={disabled} data-control-id={`harness.extension.respond:${request.id}:cancel`} aria-label={`Cancel ${request.title}`} onClick={cancel}>Cancel</button>
      </div>
    </form>}
  </section>;
}
