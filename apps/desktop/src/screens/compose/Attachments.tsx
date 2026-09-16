// The attachments on a Draft: uploads in progress with a thin bar, done ones
// as the reader's .att pills with a remove control. Uploads run through the
// Composer in chunks; the Draft references the blob id once the last chunk
// is in (ADR 0010).

import type { DraftAttachment } from "@monday/shared";
import { attachmentIcon, formatSize, Icon } from "@monday/ui";

export interface Upload {
  key: string;
  name: string;
  size: number;
  mediaType: string;
  /** 0 to 1 while uploading; 1 when done and the Draft holds the blob. */
  fraction: number;
  error?: string | undefined;
}

export interface AttachmentsProps {
  attachments: readonly DraftAttachment[];
  uploads: readonly Upload[];
  onRemove: (blobId: string) => void;
  strings: { uploading: string; remove: string };
}

export function Attachments({ attachments, uploads, onRemove, strings }: AttachmentsProps) {
  if (attachments.length === 0 && uploads.length === 0) return null;
  return (
    <div className="c-atts">
      {attachments.map((a) => (
        <span key={a.blobId} className="att" title={a.name}>
          <Icon icon={attachmentIcon(a.mediaType)} />
          <span>{a.name}</span>
          <span className="sz">{formatSize(a.size)}</span>
          <button
            type="button"
            className="x"
            aria-label={`${strings.remove}: ${a.name}`}
            onClick={() => onRemove(a.blobId)}
          >
            ×
          </button>
        </span>
      ))}
      {uploads.map((u) => (
        <span
          key={u.key}
          className="att uploading"
          title={
            u.error ?? strings.uploading.replace("{pct}", String(Math.round(u.fraction * 100)))
          }
        >
          <Icon icon={attachmentIcon(u.mediaType)} />
          <span>{u.name}</span>
          <span className="sz">
            {u.error ?? strings.uploading.replace("{pct}", String(Math.round(u.fraction * 100)))}
          </span>
          <span className="bar" style={{ width: `${Math.round(u.fraction * 100)}%` }} />
        </span>
      ))}
    </div>
  );
}

/** Reads a browser File into the bytes the Composer uploads. */
export async function fileToUpload(file: File): Promise<{
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}> {
  return {
    name: file.name,
    mediaType: file.type || "application/octet-stream",
    bytes: new Uint8Array(await file.arrayBuffer()),
  };
}
