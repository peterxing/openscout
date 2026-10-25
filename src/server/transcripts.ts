import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";
import { appendJsonl, readJsonl } from "./util.js";

export type TranscriptEntry =
  | { t: string; kind: "user"; text: string; attachments?: string[] }
  | { t: string; kind: "assistant"; text: string; messageId?: string }
  | { t: string; kind: "tool"; toolCallId: string; name: string; args?: string; success?: boolean; result?: string; server?: string }
  | { t: string; kind: "error"; text: string }
  | { t: string; kind: "info"; text: string }
  | { t: string; kind: "permission"; title: string; detail: string; decision: string }
  | { t: string; kind: "input"; question: string; answer: string };

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** UI-oriented transcript per conversation (the runtime keeps its own full event log). */
export class TranscriptStore {
  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error("Invalid session id");
    return path.join(paths.transcripts, `${id}.jsonl`);
  }

  append(id: string, entry: TranscriptEntry): void {
    appendJsonl(this.file(id), entry);
  }

  read(id: string): TranscriptEntry[] {
    return readJsonl<TranscriptEntry>(this.file(id));
  }

  remove(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }

  /** Plain-text rendering for the session_transcript tool. */
  asText(id: string, lastN: number): string {
    const lines = this.read(id)
      .slice(-lastN)
      .map((e) => {
        switch (e.kind) {
          case "user":
            return `User: ${e.text}`;
          case "assistant":
            return `Assistant: ${e.text}`;
          case "tool":
            return `[tool ${e.name} ${e.success === false ? "failed" : "ok"}]`;
          case "error":
            return `[error] ${e.text}`;
          case "permission":
            return `[permission ${e.title}: ${e.decision}]`;
          case "input":
            return `[asked] ${e.question} → ${e.answer}`;
          default:
            return `[info] ${e.text}`;
        }
      });
    return lines.join("\n\n") || "(empty conversation)";
  }
}
