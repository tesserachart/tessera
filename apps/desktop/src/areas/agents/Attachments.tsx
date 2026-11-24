import type { Attachment } from '@tessera/protocol';
import { Dialog, DialogContent, Icon, IconButton, Tooltip, cx } from '@tessera/ui';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useHasTool, useToolValue } from '../../app/tools.ts';
import { formatBytes, partialNote, splitAttachments, type Reader } from '../../analyst/attachments.ts';
import { removeFile, type ComposerFile } from '../../analyst/composerFiles.ts';

function useAttachmentUrl(id: string | null): string | null {
  const has = useHasTool('agent.get_attachment');
  const data = useToolValue('agent.get_attachment', has && id ? { id } : null, { keepFor: Infinity });
  const url = useMemo(() => {
    if (!data) return null;
    const bin = atob(data.dataBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: data.attachment.mimeType ?? 'application/octet-stream' }));
  }, [data]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

export function ComposerTray({ files, reader }: { files: readonly ComposerFile[]; reader: Reader | null }) {
  if (files.length === 0) return null;
  return (
    <ul className="ag-files" aria-label="Attachments">
      {files.map((f) => {
        const refused = f.mimeType === 'application/pdf' && reader !== null && !reader.readsPdfs;
        const note = refused ? `${reader.name} does not read PDFs` : partialNote(f);
        const uploading = f.attachment === null;
        return (
          <li
            key={f.key}
            className={cx(
              'ag-file group/file',
              f.kind === 'image' && 'is-image',
              uploading && 'is-uploading',
              refused && 'is-refused',
            )}
          >
            <Tooltip content={note ? `${f.name} · ${note}` : `${f.name} · ${formatBytes(f.sizeBytes)}`}>
              <span className="ag-file-face" tabIndex={0} aria-label={f.name}>
                {f.kind === 'image' && f.preview ? (
                  <img src={f.preview} alt="" draggable={false} />
                ) : (
                  <>
                    <Icon name="file" />
                    <span className="nm">{f.name}</span>
                    <span className="sz">{formatBytes(f.sizeBytes)}</span>
                  </>
                )}
              </span>
            </Tooltip>
            {uploading ? (
              <span
                className="ag-file-bar"
                role="progressbar"
                aria-label={`Uploading ${f.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(f.progress * 100)}
                style={{ '--p': String(f.progress) } as CSSProperties}
              />
            ) : null}
            <IconButton
              className="absolute top-0.5 right-0.5 w-hit h-hit bg-panel hover:bg-panel opacity-0 [transition:opacity_var(--dur-hover)_var(--ease-out)] group-focus-within/file:opacity-100 group-hover/file:opacity-100 *:[--icon:12px]"
              label={`Remove ${f.name}`}
              icon="remove"
              onClick={() => removeFile(f.key)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function SentImage({ a, onOpen }: { a: Attachment; onOpen: (a: Attachment, url: string) => void }) {
  const url = useAttachmentUrl(a.id ?? null);
  return (
    <button
      type="button"
      className={cx('ag-shot', !url && 'is-loading')}
      aria-label={`Open ${a.label}`}
      disabled={!url}
      onClick={() => url && onOpen(a, url)}
    >
      {url ? <img src={url} alt={a.label} draggable={false} /> : null}
    </button>
  );
}

export function MessageFiles({ attachments }: { attachments: readonly Attachment[] }) {
  const [open, setOpen] = useState<{ a: Attachment; url: string } | null>(null);
  if (attachments.length === 0) return null;
  const { images, files } = splitAttachments(attachments);
  return (
    <div className="ag-sent">
      {images.length > 0 ? (
        <div className={cx('ag-shots', images.length === 1 && 'is-one')}>
          {images.map((a) => (
            <SentImage key={a.id} a={a} onOpen={(at, url) => setOpen({ a: at, url })} />
          ))}
        </div>
      ) : null}
      {files.map((a, i) => (
        <div key={a.id ?? `${a.label}-${String(i)}`} className="ag-sent-file">
          <Icon name="file" />
          <span className="nm">{a.label}</span>
          {a.sizeBytes !== undefined ? <span className="sz">{formatBytes(a.sizeBytes)}</span> : null}
        </div>
      ))}
      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        {open ? (
          <DialogContent className="ag-lightbox" title={open.a.label}>
            <img src={open.url} alt={open.a.label} />
          </DialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
