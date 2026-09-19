import { useState } from "react";

/** Docs code samples are meant to be copied, not read — every block gets a copy button
 * rather than leaving the reader to select eight lines of PowerShell by hand. */
export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      // Purely a label reset — nothing depends on this timer, so a missed one is a
      // button that keeps saying "Copied", not a broken page.
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="group relative overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-slate-400">
          {language}
        </span>
        <button
          onClick={copy}
          className="rounded px-2 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-slate-800 hover:text-white"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
