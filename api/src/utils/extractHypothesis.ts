/**
 * Extract named sections out of a TipTap JSON document.
 *
 * A section is an H2 heading with a known title, plus every node between it and the next
 * H2 (or the end of the document). Projects use "Hypothesis" and "Success Criteria";
 * programs use "Vision" and "Goals".
 *
 * The `documents.content` column holds whatever the editor last wrote, so the value handed
 * to these functions is genuinely `unknown` — it can be null (Yjs-only documents), a doc
 * from an older schema, or a node type that has since been removed. Everything below is
 * therefore checked rather than asserted.
 */

/**
 * A TipTap node, validated only as far as the format guarantees: `type` is a string.
 *
 * `text`, `attrs` and `content` are left as `unknown` and narrowed at the point of use.
 * Declaring them `string` / `TipTapNode[]` would be a claim about stored JSON that
 * nothing checks — which is exactly what the `as TipTapDoc` assertions used to do.
 */
interface TipTapNode {
  readonly type: string;
  readonly text?: unknown;
  readonly attrs?: unknown;
  readonly content?: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTipTapNode(value: unknown): value is TipTapNode {
  return isRecord(value) && typeof value.type === 'string';
}

/** Child nodes of a node, dropping anything that is not a node. */
function childNodes(node: TipTapNode): TipTapNode[] {
  return Array.isArray(node.content) ? node.content.filter(isTipTapNode) : [];
}

/** One of a node's `attrs`, or undefined when `attrs` is absent or not an object. */
function attr(node: TipTapNode, name: string): unknown {
  return isRecord(node.attrs) ? node.attrs[name] : undefined;
}

/**
 * Top-level nodes of a TipTap document, or null if the value is not one.
 *
 * Replaces `content as TipTapDoc` followed by a `doc.type !== 'doc'` check: the same two
 * conditions, but as a guard that produces a type the rest of the file can rely on.
 */
function topLevelNodes(content: unknown): TipTapNode[] | null {
  if (!isRecord(content)) return null;
  if (content.type !== 'doc' || !Array.isArray(content.content)) return null;
  return content.content.filter(isTipTapNode);
}

/**
 * Extract plain text from a TipTap node tree.
 */
function extractText(nodes: readonly TipTapNode[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.text === 'string' && node.text) {
      text += node.text;
    } else if (node.content !== undefined) {
      text += extractText(childNodes(node));
    }
    // Add newlines after block elements
    if (['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type)) {
      text += '\n';
    }
  }
  return text;
}

/**
 * Check if a node is any H2 heading
 */
function isH2Heading(node: TipTapNode): boolean {
  return node.type === 'heading' && attr(node, 'level') === 2;
}

/** Heading text, trimmed and lowercased, for comparison against a section title. */
function headingText(node: TipTapNode): string {
  return extractText(childNodes(node)).trim().toLowerCase();
}

/**
 * Text of the section introduced by the first H2 whose text is `title`.
 *
 * Runs from the node after the heading up to the next H2, or the end of the document.
 * Returns null when the heading is absent or the section is empty.
 */
function extractSection(nodes: readonly TipTapNode[], title: string): string | null {
  const start = nodes.findIndex((node) => isH2Heading(node) && headingText(node) === title);
  if (start === -1) return null;

  const afterHeading = nodes.slice(start + 1);
  const nextH2 = afterHeading.findIndex(isH2Heading);
  const sectionNodes = nextH2 === -1 ? afterHeading : afterHeading.slice(0, nextH2);
  if (sectionNodes.length === 0) return null;

  return extractText(sectionNodes).trim() || null;
}

/** Parse the document, then extract one named section from it. */
function extractNamedSection(content: unknown, title: string): string | null {
  const nodes = topLevelNodes(content);
  return nodes === null ? null : extractSection(nodes, title);
}

/**
 * Extract hypothesis content from TipTap document JSON.
 *
 * Looks for:
 * 1. hypothesisBlock nodes (preferred - custom block component)
 * 2. H2 "Hypothesis" heading with content until next H2 (legacy format)
 *
 * @param content - TipTap JSON document
 * @returns Extracted hypothesis text, or null if no hypothesis section found
 */
export function extractHypothesisFromContent(content: unknown): string | null {
  const nodes = topLevelNodes(content);
  if (nodes === null) return null;

  // First, look for hypothesisBlock nodes (preferred)
  for (const node of nodes) {
    if (node.type === 'hypothesisBlock' && node.content !== undefined) {
      const text = extractText(childNodes(node)).trim();
      if (text) return text;
    }
  }

  // Fallback: look for H2 "Hypothesis" heading (legacy format)
  return extractSection(nodes, 'hypothesis');
}

/**
 * Extract success criteria content from TipTap document JSON.
 *
 * Finds the first H2 "Success Criteria" heading and extracts all content
 * until the next H2 heading (or end of document).
 *
 * @param content - TipTap JSON document
 * @returns Extracted success criteria text, or null if no section found
 */
export function extractSuccessCriteriaFromContent(content: unknown): string | null {
  return extractNamedSection(content, 'success criteria');
}

/**
 * Extract vision content from TipTap document JSON.
 *
 * Finds the first H2 "Vision" heading and extracts all content
 * until the next H2 heading (or end of document).
 * This is used for Program documents.
 *
 * @param content - TipTap JSON document
 * @returns Extracted vision text, or null if no section found
 */
export function extractVisionFromContent(content: unknown): string | null {
  return extractNamedSection(content, 'vision');
}

/**
 * Extract goals content from TipTap document JSON.
 *
 * Finds the first H2 "Goals" heading and extracts all content
 * until the next H2 heading (or end of document).
 * This is used for Program documents.
 *
 * @param content - TipTap JSON document
 * @returns Extracted goals text, or null if no section found
 */
export function extractGoalsFromContent(content: unknown): string | null {
  return extractNamedSection(content, 'goals');
}

/**
 * Check if a document is complete based on document type requirements.
 *
 * Requirements:
 * - Projects: need plan AND success_criteria
 * - Sprints: need plan AND at least 1 linked issue
 *   (dates are computed from sprint_number + workspace.sprint_start_date)
 *
 * @param documentType - The document type (project, sprint, etc.)
 * @param properties - The document's properties object
 * @param linkedIssuesCount - Number of issues linked to this sprint (for sprint docs)
 * @returns Object with is_complete boolean and array of missing fields
 */
export function checkDocumentCompleteness(
  documentType: string,
  properties: Record<string, unknown> | null,
  linkedIssuesCount: number = 0
): { isComplete: boolean; missingFields: string[] } {
  const props = properties || {};
  const missingFields: string[] = [];

  if (documentType === 'project') {
    // Projects need plan + success_criteria
    if (!props.plan || (typeof props.plan === 'string' && !props.plan.trim())) {
      missingFields.push('Plan');
    }
    if (!props.success_criteria || (typeof props.success_criteria === 'string' && !props.success_criteria.trim())) {
      missingFields.push('Success Criteria');
    }
  } else if (documentType === 'sprint') {
    // Sprints need at least 1 linked issue
    // Plans are now per-person weekly_plan documents, not sprint properties
    if (linkedIssuesCount === 0) {
      missingFields.push('Linked Issues');
    }
  }
  // Other document types don't have completeness requirements

  return {
    isComplete: missingFields.length === 0,
    missingFields,
  };
}
