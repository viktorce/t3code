import { extractFenceTitle } from "@t3tools/shared/markdownCodeFence";
import { markdownMathRanges } from "@t3tools/shared/markdownMath";
import {
  captureAssistantTextOpening,
  createAssistantTextSelector,
} from "@t3tools/shared/assistantCitations";
import {
  splitCodexArtifactTemplateMarkdown,
  renderCodexInlineDirectivesAsMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { splitMarkdownDetails } from "./markdownDetails";
import {
  markdownReferenceDefinitions,
  parseMarkdownDocument,
  withReferenceDefinitions,
  type MarkdownNode,
} from "./markdownDocument";

function renderedText(
  node: MarkdownNode,
  restoreMath: (value: string) => string,
  includeFenceTitle: boolean,
): string {
  if (
    node.type === "definition" ||
    node.type === "image" ||
    node.type === "imageReference" ||
    node.type === "html" ||
    (node.type === "code" && node.lang === "mermaid")
  )
    return "";
  if (node.type === "code") {
    const code = restoreMath(node.value);
    const title = includeFenceTitle ? extractFenceTitle(node.meta ?? undefined) : null;
    return title ? (code ? `${title}\n${code}` : title) : code;
  }
  if ("value" in node) return restoreMath(node.value);
  if ("children" in node) {
    const inline =
      node.type === "paragraph" ||
      node.type === "heading" ||
      node.type === "link" ||
      node.type === "linkReference" ||
      node.type === "emphasis" ||
      node.type === "strong" ||
      node.type === "delete" ||
      node.type === "tableCell";
    return node.children
      .map((child) => renderedText(child, restoreMath, includeFenceTitle))
      .filter((text) => text.length > 0)
      .join(inline ? "" : "\n");
  }
  return node.type === "break" ? "\n" : "";
}

function citationText(markdown: string, includeFenceTitle: boolean): string {
  const formulas = markdownMathRanges(markdown);
  let marker = "\ue000t3math";
  while (markdown.includes(marker)) marker += "_";
  const tokens = formulas.map((_, index) => `${marker}${index}\ue001`);
  let cursor = 0;
  let prose = "";
  for (const [index, formula] of formulas.entries()) {
    prose += markdown.slice(cursor, formula.start) + tokens[index];
    cursor = formula.end;
  }
  prose += markdown.slice(cursor);
  return renderedText(
    parseMarkdownDocument(prose),
    (value) =>
      value.replace(new RegExp(`${marker}(\\d+)\ue001`, "g"), (_, index: string) => {
        const formula = formulas[Number(index)]!;
        const tex = formula.tex.trim();
        return formula.display ? `\\[\n${tex}\n\\]` : `\\(${tex}\\)`;
      }),
    includeFenceTitle,
  );
}

function citationSegments(
  markdown: string,
  options?: {
    readonly path?: string;
    readonly definitions?: ReadonlyArray<string>;
    readonly includeFenceTitle?: boolean;
  },
): Array<{ path: string; text: string }> {
  const path = options?.path ?? "";
  const definitions = options?.definitions ?? markdownReferenceDefinitions(markdown);
  const includeFenceTitle = options?.includeFenceTitle ?? false;
  return splitMarkdownDetails(markdown).flatMap((block, index) => {
    if (block.kind === "details")
      return citationSegments(block.body, {
        path: `${path}${index}/`,
        definitions,
        includeFenceTitle,
      });
    return splitCodexArtifactTemplateMarkdown(block.markdown).flatMap((segment, segmentIndex) =>
      segment.kind === "markdown"
        ? [
            {
              path: `${path}${index}:${segmentIndex}`,
              text: citationText(
                renderCodexInlineDirectivesAsMarkdown(
                  withReferenceDefinitions(segment.markdown, definitions),
                ),
                includeFenceTitle,
              ),
            },
          ]
        : [],
    );
  });
}

function occurrences(text: string, quote: string): number[] {
  const result: number[] = [];
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1))
    result.push(index);
  return result;
}

export function collectMobileAssistantTextSelectors(markdown: string, path: string, text: string) {
  if (!text.trim()) return [];
  const normalize = (value: string) => value.replace(/\s+/g, " ");
  const quote = normalize(text);
  const segments = citationSegments(markdown).filter((segment) => segment.text.trim().length > 0);
  const segmentIndex = segments.findIndex((segment) => segment.path === path);
  const segment = segments[segmentIndex];
  if (!segment) return [];
  const fullText = normalize(segments.map((entry) => entry.text).join("\n"));
  const throughSegment = segments
    .slice(0, segmentIndex + 1)
    .map((entry) => entry.text)
    .join("\n");
  const offset = normalize(throughSegment).length - normalize(segment.text).length;
  const matches = occurrences(fullText, quote);
  const localMatches = occurrences(normalize(segment.text), quote);
  if (localMatches.length > 20) return [];
  return localMatches.flatMap((localStart) => {
    const start = offset + localStart;
    const index = matches.indexOf(start);
    if (index === -1) return [];
    const selector = createAssistantTextSelector(fullText, start, start + quote.length);
    return selector ? [{ selector: { ...selector, text }, index, count: matches.length }] : [];
  });
}

export function captureMobileAssistantMessageOpening(markdown: string) {
  const rendered = citationSegments(markdown, { includeFenceTitle: true })
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
    .join("\n");
  return captureAssistantTextOpening(rendered || markdown);
}
