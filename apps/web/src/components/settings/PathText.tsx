import { Fragment, type ReactNode } from "react";

// Paths break after a separator, either slash. Each folder name moves to the next line whole,
// so it splits at a hyphen or anywhere else only when it is longer than a line.
export function PathText({ text }: { text: string }) {
  const segments: ReactNode[] = [];
  for (let start = 0; start < text.length;) {
    const separator = text.slice(start).search(/[\\/]/);
    const end = separator === -1 ? text.length : start + separator + 1;
    segments.push(
      <Fragment key={start}>
        <span className="inline-block">{text.slice(start, end)}</span>
        <wbr />
      </Fragment>,
    );
    start = end;
  }
  return segments;
}
