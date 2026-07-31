import * as Dialog from '@radix-ui/react-dialog';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'default' | 'destructive';
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const confirmButtonClass = variant === 'destructive'
    ? 'bg-red-600 hover:bg-red-700 focus:ring-red-600'
    : 'bg-accent hover:bg-accent/90 focus:ring-accent';

  return (
    <Dialog.Root open={open} onOpenChange={(isOpen) => !isOpen && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[100] bg-black/60" />
        {/* focus:outline-none is deliberate here and at the other four Dialog.Content
            sites. Radix renders this container with tabindex="-1" and focuses it when the
            dialog opens; it is not in the tab sequence, so WCAG 2.4.7 does not apply to it,
            and the modal appearing over a dimmed overlay is itself the state change. The
            focusable controls inside carry their own focus:ring. */}
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[101] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-6 shadow-xl focus:outline-none"
          onEscapeKeyDown={onCancel}
        >
          <Dialog.Title className="text-lg font-semibold text-foreground">
            {title}
          </Dialog.Title>

          <Dialog.Description className="mt-2 text-sm text-muted">
            {description}
          </Dialog.Description>

          {children && (
            <div className="mt-4">
              {children}
            </div>
          )}

          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={onCancel}
              className="rounded-md bg-border px-4 py-2 text-sm font-medium text-foreground hover:bg-border/80 focus:outline-none focus:ring-2 focus:ring-border focus:ring-offset-2 focus:ring-offset-background"
            >
              {cancelLabel}
            </button>
            <button
              onClick={onConfirm}
              className={`rounded-md px-4 py-2 text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background ${confirmButtonClass}`}
            >
              {confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
