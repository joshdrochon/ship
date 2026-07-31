import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

type DocumentType = 'wiki' | 'issue' | 'project' | 'program' | 'sprint' | 'person' | 'weekly_plan' | 'weekly_retro' | 'standup' | null;

interface CurrentDocumentContextValue {
  currentDocumentType: DocumentType;
  currentDocumentId: string | null;
  currentDocumentProjectId: string | null;
  /**
   * Title of the open document, so the app shell can put it in `document.title`.
   *
   * The shell derives every other page title from the path, but every document editor
   * is `/documents/:id` -- the path cannot tell a project from a wiki, let alone name
   * it, which is why all five of them announced "Ship | Ship" (W7-8). The page holding
   * the fetched document is the only place that knows, so it reports it up here.
   */
  currentDocumentTitle: string | null;
  setCurrentDocument: (
    id: string | null,
    type: DocumentType,
    projectId?: string | null,
    title?: string | null
  ) => void;
  clearCurrentDocument: () => void;
}

const CurrentDocumentContext = createContext<CurrentDocumentContextValue | undefined>(undefined);

export function CurrentDocumentProvider({ children }: { children: ReactNode }) {
  const [currentDocumentId, setCurrentDocumentId] = useState<string | null>(null);
  const [currentDocumentType, setCurrentDocumentType] = useState<DocumentType>(null);
  const [currentDocumentProjectId, setCurrentDocumentProjectId] = useState<string | null>(null);
  const [currentDocumentTitle, setCurrentDocumentTitle] = useState<string | null>(null);

  const setCurrentDocument = useCallback((
    id: string | null,
    type: DocumentType,
    projectId?: string | null,
    title?: string | null
  ) => {
    setCurrentDocumentId(id);
    setCurrentDocumentType(type);
    setCurrentDocumentProjectId(projectId ?? null);
    setCurrentDocumentTitle(title ?? null);
  }, []);

  const clearCurrentDocument = useCallback(() => {
    setCurrentDocumentId(null);
    setCurrentDocumentType(null);
    setCurrentDocumentProjectId(null);
    setCurrentDocumentTitle(null);
  }, []);

  return (
    <CurrentDocumentContext.Provider
      value={{
        currentDocumentType,
        currentDocumentId,
        currentDocumentProjectId,
        currentDocumentTitle,
        setCurrentDocument,
        clearCurrentDocument,
      }}
    >
      {children}
    </CurrentDocumentContext.Provider>
  );
}

export function useCurrentDocument() {
  const context = useContext(CurrentDocumentContext);
  if (!context) {
    throw new Error('useCurrentDocument must be used within a CurrentDocumentProvider');
  }
  return context;
}

/**
 * Hook to get the current document type without throwing.
 * Returns null if not in a CurrentDocumentProvider context.
 * Useful for optional context usage.
 */
export function useCurrentDocumentType(): DocumentType {
  const context = useContext(CurrentDocumentContext);
  return context?.currentDocumentType ?? null;
}
