import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UnifiedEditor } from '@/components/UnifiedEditor';
import type { UnifiedDocument, SidebarData } from '@/components/UnifiedEditor';
import { useAuth } from '@/hooks/useAuth';
import { useAssignableMembersQuery } from '@/hooks/useTeamMembersQuery';
import { useProgramsQuery } from '@/hooks/useProgramsQuery';
import { apiPatch, apiDelete, apiPost } from '@/lib/api';
import { useToast } from '@/components/ui/Toast';
import { issueKeys } from '@/hooks/useIssuesQuery';
import { projectKeys } from '@/hooks/useProjectsQuery';
import type { DocumentTabProps } from '@/lib/document-tabs';
import {
  readBelongsTo,
  readBooleanOrNull,
  readField,
  readFields,
  readNumberOrNull,
  readPersonRef,
  readString,
  readStringOrNull,
  readStringArray,
} from '@/lib/document-fields';
import { computeICEScore } from '@ship/shared';

/**
 * ProjectDetailsTab - Renders the project document in the UnifiedEditor
 *
 * This is the "Details" tab content when viewing a project document.
 */
export default function ProjectDetailsTab({ documentId, document }: DocumentTabProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const { showToast } = useToast();

  // Track conversion state separately from update mutation
  const [isConverting, setIsConverting] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);

  // Fetch team members for sidebar
  const { data: teamMembersData = [] } = useAssignableMembersQuery();
  const teamMembers = useMemo(() => teamMembersData.map(m => ({
    id: m.id,
    user_id: m.user_id,
    name: m.name,
    email: m.email || '',
  })), [teamMembersData]);

  // Fetch programs for sidebar
  const { data: programsData = [] } = useProgramsQuery();
  const programs = useMemo(() => programsData.map(p => ({
    id: p.id,
    name: p.name,
    color: p.color,
    emoji: p.emoji,
  })), [programsData]);

  // Update mutation with optimistic updates
  const updateMutation = useMutation({
    mutationFn: async (updates: Partial<UnifiedDocument>) => {
      const response = await apiPatch(`/api/documents/${documentId}`, updates);
      if (!response.ok) {
        throw new Error('Failed to update document');
      }
      return response.json();
    },
    onMutate: async (updates) => {
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ['document', documentId] });
      await queryClient.cancelQueries({ queryKey: projectKeys.lists() });

      // Snapshot the previous value
      const previousDocument = queryClient.getQueryData<Record<string, unknown>>(['document', documentId]);

      // Optimistically update the document cache
      if (previousDocument) {
        const updatedDocument: Record<string, unknown> = { ...previousDocument, ...updates };

        // Recompute ICE score if any ICE property changed
        if ('impact' in updates || 'confidence' in updates || 'ease' in updates) {
          // Each component falls back to the cached value, so a partial update
          // (impact only) still scores against the confidence and ease already stored.
          const iceComponent = (key: 'impact' | 'confidence' | 'ease') =>
            readNumberOrNull(readField(updates, key) ?? previousDocument[key]);
          updatedDocument.ice_score = computeICEScore(
            iceComponent('impact'),
            iceComponent('confidence'),
            iceComponent('ease')
          );
        }

        queryClient.setQueryData(['document', documentId], updatedDocument);
      }

      // Return context with the previous value for rollback
      return { previousDocument };
    },
    onError: (_err, _updates, context) => {
      // Rollback to the previous value on error
      if (context?.previousDocument) {
        queryClient.setQueryData(['document', documentId], context.previousDocument);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['document', documentId] });
      queryClient.invalidateQueries({ queryKey: projectKeys.lists() });
    },
  });

  // Delete mutation
  const deleteMutation = useMutation({
    mutationFn: async () => {
      const response = await apiDelete(`/api/documents/${documentId}`);
      if (!response.ok) {
        throw new Error('Failed to delete document');
      }
    },
    onSuccess: () => {
      navigate('/projects');
    },
  });

  // Handle type change (project <-> issue conversion)
  const handleTypeChange = useCallback(async (newType: string) => {
    const isValidConversion = newType === 'issue';
    if (!isValidConversion) {
      showToast(`Converting project to ${newType} is not supported`, 'error');
      return;
    }

    try {
      const res = await apiPost(`/api/documents/${documentId}/convert`, { target_type: newType });
      if (res.ok) {
        const data = await res.json();
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: issueKeys.lists() }),
          queryClient.invalidateQueries({ queryKey: projectKeys.lists() }),
          queryClient.invalidateQueries({ queryKey: ['document', documentId] }),
        ]);
        navigate(`/documents/${data.id}`, { replace: true });
      } else {
        const error = await res.json();
        showToast(error.error || 'Failed to convert document', 'error');
      }
    } catch (err) {
      showToast('Failed to convert document', 'error');
    }
  }, [documentId, navigate, queryClient, showToast]);

  // Handle conversion callbacks
  const handleConvert = useCallback(async () => {
    setIsConverting(true);
    try {
      await handleTypeChange('issue');
    } finally {
      setIsConverting(false);
    }
  }, [handleTypeChange]);

  const handleUndoConversion = useCallback(async () => {
    setIsUndoing(true);
    try {
      const res = await apiPost(`/api/documents/${documentId}/undo-conversion`, {});
      if (res.ok) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: issueKeys.lists() }),
          queryClient.invalidateQueries({ queryKey: projectKeys.lists() }),
          queryClient.invalidateQueries({ queryKey: ['document', documentId] }),
        ]);
        showToast('Conversion undone successfully', 'success');
      } else {
        const error = await res.json();
        showToast(error.error || 'Failed to undo conversion', 'error');
      }
    } catch (err) {
      showToast('Failed to undo conversion', 'error');
    } finally {
      setIsUndoing(false);
    }
  }, [documentId, queryClient, showToast]);

  // Handle WebSocket notification
  const handleDocumentConverted = useCallback((newDocId: string) => {
    navigate(`/documents/${newDocId}`, { replace: true });
  }, [navigate]);

  // Handle back navigation
  const handleBack = useCallback(() => {
    navigate('/projects');
  }, [navigate]);

  // Handle update
  const handleUpdate = useCallback(async (updates: Partial<UnifiedDocument>) => {
    await updateMutation.mutateAsync(updates);
  }, [updateMutation]);

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!window.confirm('Are you sure you want to delete this project?')) return;
    await deleteMutation.mutateAsync();
  }, [deleteMutation]);

  // Build sidebar data
  const sidebarData: SidebarData = useMemo(() => ({
    programs,
    people: teamMembers,
    onConvert: handleConvert,
    onUndoConversion: handleUndoConversion,
    isConverting,
    isUndoing,
  }), [programs, teamMembers, handleConvert, handleUndoConversion, isConverting, isUndoing]);

  // Get program_id from belongs_to array (project's parent program via document_associations)
  const belongsTo = readBelongsTo(document.belongs_to);
  const programId = belongsTo.find(b => b.type === 'program')?.id;

  // Transform to UnifiedDocument format. Every field below arrives as `unknown` on
  // DocumentResponse and is checked at runtime rather than asserted.
  const unifiedDocument: UnifiedDocument = useMemo(() => ({
    id: document.id,
    title: document.title,
    document_type: 'project',
    created_at: document.created_at,
    updated_at: document.updated_at,
    created_by: document.created_by,
    properties: readFields(document.properties),
    impact: readNumberOrNull(document.impact),
    confidence: readNumberOrNull(document.confidence),
    ease: readNumberOrNull(document.ease),
    color: readString(document.color) || '#3b82f6',
    emoji: null,
    program_id: programId,
    owner: readPersonRef(document.owner),
    owner_id: readString(document.owner_id),
    // RACI fields
    accountable_id: readString(document.accountable_id),
    consulted_ids: readStringArray(document.consulted_ids),
    informed_ids: readStringArray(document.informed_ids),
    converted_from_id: readString(document.converted_from_id),
    // Design review
    has_design_review: readBooleanOrNull(document.has_design_review),
    design_review_notes: readStringOrNull(document.design_review_notes),
  }), [document, programId]);

  if (!user) return null;

  return (
    <UnifiedEditor
      document={unifiedDocument}
      sidebarData={sidebarData}
      onUpdate={handleUpdate}
      onTypeChange={handleTypeChange}
      onDocumentConverted={handleDocumentConverted}
      onBack={handleBack}
      backLabel="projects"
      onDelete={handleDelete}
      showTypeSelector={true}
    />
  );
}
