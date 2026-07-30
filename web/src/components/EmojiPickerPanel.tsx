import EmojiPicker, { Theme, EmojiClickData } from 'emoji-picker-react';

/**
 * The emoji-picker-react surface, isolated behind a default export so it can be
 * reached only through `import()`.
 *
 * emoji-picker-react ships its full emoji dataset, and it was previously pulled
 * in by a static import in EmojiPicker.tsx — meaning every user paid for it on
 * first load whether or not they ever opened a picker. Keeping the library
 * confined to this module is what lets Rollup put it in a chunk of its own; a
 * static `import 'emoji-picker-react'` anywhere else would undo that.
 */
export default function EmojiPickerPanel({
  onEmojiClick,
}: {
  onEmojiClick: (emojiData: EmojiClickData) => void;
}) {
  return (
    <EmojiPicker
      onEmojiClick={onEmojiClick}
      skinTonesDisabled={true}
      theme={Theme.DARK}
      height={350}
      width={300}
      searchPlaceholder="Search emoji..."
      previewConfig={{ showPreview: false }}
    />
  );
}
