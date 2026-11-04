// Parses the `patch` field GitHub returns for each file in a pull request
// (a unified diff without the ---/+++ file headers) and returns the line
// numbers that were added in the new version of the file.
//
// Example hunk header:  @@ -10,7 +10,9 @@ function foo() {
//                            ^old    ^new: starts at line 10

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseAddedLines(patch: string): Set<number> {
  const added = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    const marker = raw[0];
    if (marker === "+") {
      added.add(newLine);
      newLine++;
    } else if (marker === " ") {
      newLine++;
    }
    // "-" lines exist only in the old file; "\" is "\ No newline at end of file".
  }

  return added;
}
