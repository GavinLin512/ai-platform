// Core types shared by every rule and every integration (GitHub App now, CLI / Action later).
// Nothing in src/core may import from src/github — keep this layer platform-agnostic.

export type Severity = "error" | "warning" | "info";

export interface SourceFile {
  /** Repository-relative path, e.g. "src/components/Cart.tsx". */
  path: string;
  content: string;
}

export interface Finding {
  ruleId: string;
  path: string;
  /** 1-based line number in the new version of the file. */
  line: number;
  /** 1-based column. */
  column: number;
  severity: Severity;
  message: string;
  /** The offending text (e.g. the hardcoded string). Used for de-duplication. */
  text: string;
}

export interface Rule {
  id: string;
  description: string;
  /** Cheap path-based filter so we never parse files a rule does not care about. */
  appliesTo(path: string): boolean;
  check(file: SourceFile): Finding[];
}
