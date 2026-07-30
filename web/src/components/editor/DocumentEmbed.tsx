import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, NodeViewProps } from '@tiptap/react';
import { useNavigate } from 'react-router-dom';

// The React component that renders the document embed
function DocumentEmbedComponent({ node }: NodeViewProps) {
  const navigate = useNavigate();
  const { documentId, title } = node.attrs as { documentId: string; title: string };

  const handleClick = () => {
    navigate(`/documents/${documentId}`);
  };

  return (
    <NodeViewWrapper className="document-embed" contentEditable={false} data-document-embed>
      <button
        type="button"
        onClick={handleClick}
        className="flex w-full items-center gap-2 rounded-md border border-border bg-background/50 px-3 py-2 text-left text-sm transition-colors hover:bg-border/30 cursor-pointer my-1"
      >
        <svg aria-hidden="true" focusable="false"
          className="h-4 w-4 flex-shrink-0 text-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <span className="text-foreground">{title || 'Untitled'}</span>
      </button>
    </NodeViewWrapper>
  );
}

// The TipTap node extension
export const DocumentEmbed = Node.create({
  name: 'documentEmbed',

  group: 'block',

  atom: true, // Non-editable, treated as a single unit

  addAttributes() {
    return {
      documentId: {
        default: null,
      },
      title: {
        default: 'Untitled',
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-document-embed]',
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-document-embed': '' })];
  },

  addNodeView() {
    return ReactNodeViewRenderer(DocumentEmbedComponent);
  },
});
