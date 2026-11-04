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
  /** What identifies this issue (e.g. the hardcoded string). Used for de-duplication. */
  text: string;
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

/**
 * Read-only view of the repository at the commit under review.
 * Rules use it to look at files the change did not touch (e.g. the other locales).
 * GitHub, the local file system and tests each provide their own implementation.
 */
export interface RepoReader {
  /** File contents, or undefined if the file does not exist. */
  readFile(path: string): Promise<string | undefined>;
  /** Entries directly inside a directory ("" is the repository root); empty if it does not exist. */
  listDir(path: string): Promise<DirEntry[]>;
}

export interface RuleContext {
  reader: RepoReader;
  /**
   * Every file in the change, mapped to the lines it added (undefined: treat every line as new).
   * Lets a rule leave an issue to the file where it will be reported anyway.
   */
  changedFiles: ReadonlyMap<string, ReadonlySet<number> | undefined>;
}

export interface Rule {
  id: string;
  description: string;
  /** Cheap path-based filter so we never parse files a rule does not care about. */
  appliesTo(path: string): boolean;
  check(file: SourceFile, context: RuleContext): Finding[] | Promise<Finding[]>;
}
