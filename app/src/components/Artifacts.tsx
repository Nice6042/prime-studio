import { useCallback, useEffect, useState } from "react";
import * as rpc from "../rpc";
import { CodeBlock } from "../Markdown";
import type { WorkspaceFile } from "../types";

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  css: "css",
  html: "xml",
  md: "markdown",
  toml: "ini",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  sql: "sql",
};

const extOf = (p: string) => p.split(".").pop()?.toLowerCase() ?? "";

function normalize(raw: WorkspaceFile[] | string[]): WorkspaceFile[] {
  return (raw as unknown[]).map((f) =>
    typeof f === "string"
      ? { name: f.split(/[\\/]/).pop() ?? f, path: f }
      : (f as WorkspaceFile),
  );
}

export function Artifacts({ cwd }: { cwd: string | null }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [sel, setSel] = useState<WorkspaceFile | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!cwd) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setFiles(normalize(await rpc.listWorkspaceFiles(cwd)));
    setLoading(false);
  }, [cwd]);

  useEffect(() => {
    setSel(null);
    setContent(null);
    void refresh();
  }, [refresh]);

  const open = async (f: WorkspaceFile) => {
    setSel(f);
    setContent(null);
    setContent((await rpc.readWorkspaceFile(f.path)) ?? "");
  };

  const ext = sel ? extOf(sel.path) : "";
  const isHtml = ext === "html" || ext === "htm";

  return (
    <aside className="artifacts">
      <div className="artifacts-head">
        <strong>Artifacts</strong>
        {sel && (
          <button className="btn btn-icon" onClick={() => setSel(null)} title="Back to file list">
            ←
          </button>
        )}
        <button className="btn btn-icon" onClick={() => (sel ? void open(sel) : void refresh())} title="Refresh">
          ⟳
        </button>
      </div>

      {!cwd && <div className="muted pad">Pick a working directory to see files.</div>}

      {cwd && !sel && (
        <div className="file-list">
          {loading && <div className="muted pad">Loading…</div>}
          {!loading && files.length === 0 && <div className="muted pad">No files.</div>}
          {files
            .filter((f) => !f.is_dir)
            .map((f) => (
              <button key={f.path} className="file" onClick={() => void open(f)}>
                <span className="file-name">{f.name}</span>
                <span className="file-ext">{extOf(f.path)}</span>
              </button>
            ))}
        </div>
      )}

      {sel && (
        <div className="preview">
          <div className="preview-name">{sel.name}</div>
          {content === null ? (
            <div className="muted pad">Loading…</div>
          ) : isHtml ? (
            // No allow-same-origin: rendered pages can script themselves but not touch the app.
            <iframe className="preview-frame" sandbox="allow-scripts" srcDoc={content} title={sel.name} />
          ) : (
            <div className="preview-src">
              <CodeBlock code={content} lang={EXT_LANG[ext] ?? ""} />
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
