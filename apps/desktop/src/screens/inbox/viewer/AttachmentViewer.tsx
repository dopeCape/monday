// An attachment opened inside monday, in a floating window over the reader:
// images, PDFs (pdf.js), Word documents (docx-preview), spreadsheets
// (read-excel-file), CSV and TSV (papaparse), text and code, audio and
// video, the file list of a zip (fflate) and an attached email
// (postal-mime). The heavy libraries load only when a file of their kind is
// opened. Anything else says so, with Download. Escape closes; the arrow keys
// move between the message's attachments. Nothing in a file runs: text is
// text, a Word document is laid out as inert HTML, and an attached email
// shows its text part.

import { Btn, cx, formatSize, Icon } from "@monday/ui";
import {
  CaretLeftIcon,
  CaretRightIcon,
  DownloadSimpleIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { displayType, type ViewerKind, viewerKind } from "./kind.ts";

export interface ViewerFile {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

export interface ViewerStrings {
  close: string;
  download: string;
  previous: string;
  next: string;
  loading: string;
  noPreview: string;
  tooLarge: string;
  failed: string;
  rowsMore: string;
  pageOf: string;
  zipFiles: string;
  from: string;
  to: string;
  date: string;
  zoomIn: string;
  zoomOut: string;
  label: string;
}

export interface AttachmentViewerProps {
  files: readonly ViewerFile[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** The attachment's bytes, from the Server. */
  load: (id: string) => Promise<{ bytes: Uint8Array; mediaType: string }>;
  onDownload: (file: ViewerFile) => void;
  strings: ViewerStrings;
  /** reader.preview_max_mb in bytes: larger files offer Download only. */
  maxBytes: number;
  /** reader.preview_max_rows: rows shown per sheet or CSV. */
  maxRows: number;
}

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

type Loaded =
  | { state: "loading" }
  | { state: "ready"; bytes: Uint8Array; mediaType: string }
  | { state: "error"; message: string };

export function AttachmentViewer(props: AttachmentViewerProps) {
  const { files, index, onIndex, onClose, strings } = props;
  const file = files[index];
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const panel = useRef<HTMLDivElement>(null);
  const kind: ViewerKind = file ? viewerKind(file.name, file.mediaType) : "none";
  const tooLarge = file ? file.size > props.maxBytes : false;

  // The bytes of the file on show; a newer pick drops a slower answer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new file is the only reason to load again
  useEffect(() => {
    if (!file || kind === "none" || tooLarge) return;
    let live = true;
    setLoaded({ state: "loading" });
    props
      .load(file.id)
      .then((r) => {
        if (live) setLoaded({ state: "ready", bytes: r.bytes, mediaType: r.mediaType });
      })
      .catch((e: unknown) => {
        if (live)
          setLoaded({ state: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [file?.id, kind, tooLarge]);

  // Escape closes, the arrows move; the focus stays inside the window.
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        onIndex(index - 1);
      } else if (e.key === "ArrowRight" && index < files.length - 1) {
        e.preventDefault();
        onIndex(index + 1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, files.length, onClose, onIndex]);

  if (!file) return null;

  let body: ReactNode;
  if (kind === "none") {
    body = <Notice text={fill(strings.noPreview, { name: file.name })} />;
  } else if (tooLarge) {
    body = (
      <Notice text={fill(strings.tooLarge, { name: file.name, size: formatSize(file.size) })} />
    );
  } else if (loaded.state === "loading") {
    body = <Notice text={fill(strings.loading, { name: file.name })} busy />;
  } else if (loaded.state === "error") {
    body = <Notice text={fill(strings.failed, { name: file.name, message: loaded.message })} />;
  } else {
    body = (
      <FileBody
        kind={kind}
        file={file}
        bytes={loaded.bytes}
        mediaType={displayType(file.name, loaded.mediaType || file.mediaType)}
        strings={strings}
        maxRows={props.maxRows}
      />
    );
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click outside the window closes it; Escape and Close are the keyboard path
    <div
      className="scrim viewer-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className="viewer"
        role="dialog"
        aria-modal="true"
        aria-label={fill(strings.label, { name: file.name })}
        tabIndex={-1}
        data-kind={kind}
      >
        <div className="viewer-head">
          <div className="viewer-title">
            <b title={file.name}>{file.name}</b>
            <span>{formatSize(file.size)}</span>
          </div>
          {files.length > 1 ? (
            <div className="viewer-nav">
              <Btn
                icon
                sm
                title={strings.previous}
                aria-label={strings.previous}
                disabled={index === 0}
                onClick={() => onIndex(index - 1)}
              >
                <Icon icon={CaretLeftIcon} />
              </Btn>
              <span>
                {index + 1} / {files.length}
              </span>
              <Btn
                icon
                sm
                title={strings.next}
                aria-label={strings.next}
                disabled={index === files.length - 1}
                onClick={() => onIndex(index + 1)}
              >
                <Icon icon={CaretRightIcon} />
              </Btn>
            </div>
          ) : null}
          <Btn sm onClick={() => props.onDownload(file)}>
            <Icon icon={DownloadSimpleIcon} /> {strings.download}
          </Btn>
          <Btn icon sm title={strings.close} aria-label={strings.close} onClick={onClose}>
            <Icon icon={XIcon} />
          </Btn>
        </div>
        <div className="viewer-body">{body}</div>
      </div>
    </div>
  );
}

function Notice({ text, busy }: { text: string; busy?: boolean }) {
  return (
    <div className={cx("viewer-notice", busy && "busy")} role={busy ? "status" : undefined}>
      {text}
    </div>
  );
}

interface FileBodyProps {
  kind: ViewerKind;
  file: ViewerFile;
  bytes: Uint8Array;
  mediaType: string;
  strings: ViewerStrings;
  maxRows: number;
}

function FileBody(props: FileBodyProps) {
  switch (props.kind) {
    case "image":
      return <ImageView {...props} />;
    case "audio":
    case "video":
      return <MediaView {...props} />;
    case "pdf":
      return <PdfView {...props} />;
    case "docx":
      return <DocxView {...props} />;
    case "sheet":
      return <SheetView {...props} />;
    case "csv":
      return <CsvView {...props} />;
    case "zip":
      return <ZipView {...props} />;
    case "email":
      return <EmailView {...props} />;
    case "markdown":
    case "text":
      return <TextView {...props} />;
    default:
      return <Notice text={fill(props.strings.noPreview, { name: props.file.name })} />;
  }
}

/** A blob URL for the bytes, revoked when the view goes. */
function useBlobUrl(bytes: Uint8Array, mediaType: string): string {
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType })),
    [bytes, mediaType],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return url;
}

function ImageView({ bytes, mediaType, file, strings }: FileBodyProps) {
  const url = useBlobUrl(bytes, mediaType);
  const [zoom, setZoom] = useState(1);
  return (
    <div className="viewer-image" data-zoom={zoom === 1 ? "fit" : "zoomed"}>
      <div className="viewer-tools">
        <Btn
          icon
          sm
          title={strings.zoomOut}
          aria-label={strings.zoomOut}
          disabled={zoom <= 1}
          onClick={() => setZoom((z) => Math.max(1, z / 1.5))}
        >
          <Icon icon={MagnifyingGlassMinusIcon} />
        </Btn>
        <Btn
          icon
          sm
          title={strings.zoomIn}
          aria-label={strings.zoomIn}
          disabled={zoom >= 8}
          onClick={() => setZoom((z) => Math.min(8, z * 1.5))}
        >
          <Icon icon={MagnifyingGlassPlusIcon} />
        </Btn>
      </div>
      <img
        src={url}
        alt={file.name}
        style={zoom === 1 ? undefined : { maxWidth: "none", width: `${zoom * 100}%` }}
      />
    </div>
  );
}

function MediaView({ kind, bytes, mediaType }: FileBodyProps) {
  const url = useBlobUrl(bytes, mediaType);
  return kind === "audio" ? (
    // biome-ignore lint/a11y/useMediaCaption: a mail attachment has no captions to offer
    <audio className="viewer-audio" controls src={url} />
  ) : (
    // biome-ignore lint/a11y/useMediaCaption: a mail attachment has no captions to offer
    <video className="viewer-video" controls src={url} />
  );
}

function TextView({ bytes, kind }: FileBodyProps) {
  const text = useMemo(() => new TextDecoder("utf-8", { fatal: false }).decode(bytes), [bytes]);
  return (
    <pre className={cx("viewer-text", kind === "markdown" && "wrap")}>
      <code>{text}</code>
    </pre>
  );
}

function Table({
  rows,
  maxRows,
  strings,
}: {
  rows: readonly (readonly unknown[])[];
  maxRows: number;
  strings: ViewerStrings;
}) {
  const shown = rows.slice(0, maxRows);
  const [head, ...rest] = shown;
  const cell = (v: unknown) =>
    v === null || v === undefined ? "" : v instanceof Date ? v.toLocaleString() : String(v);
  return (
    <div className="viewer-table">
      <table>
        {head ? (
          <thead>
            <tr>
              {head.map((v, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their place
                <th key={i}>{cell(v)}</th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {rest.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
            <tr key={r}>
              {row.map((v, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns have no identity but their place
                <td key={i}>{cell(v)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > maxRows ? (
        <div className="viewer-more">
          {fill(strings.rowsMore, { n: maxRows, total: rows.length })}
        </div>
      ) : null}
    </div>
  );
}

/** Runs an async parse of the bytes; its result, its failure, or loading. */
function useParsed<T>(bytes: Uint8Array, parse: (bytes: Uint8Array) => Promise<T>) {
  const [out, setOut] = useState<{ value?: T; error?: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the parser is fixed per view
  useEffect(() => {
    let live = true;
    setOut(null);
    parse(bytes)
      .then((value) => live && setOut({ value }))
      .catch((e: unknown) => live && setOut({ error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [bytes]);
  return out;
}

function Parsed<T>({
  result,
  file,
  strings,
  children,
}: {
  result: { value?: T; error?: string } | null;
  file: ViewerFile;
  strings: ViewerStrings;
  children: (value: T) => ReactNode;
}) {
  if (!result) return <Notice text={fill(strings.loading, { name: file.name })} busy />;
  if (result.error !== undefined || result.value === undefined) {
    return <Notice text={fill(strings.failed, { name: file.name, message: result.error ?? "" })} />;
  }
  return <>{children(result.value)}</>;
}

function CsvView(props: FileBodyProps) {
  const result = useParsed(props.bytes, async (bytes) => {
    const Papa = (await import("papaparse")).default;
    const text = new TextDecoder().decode(bytes);
    return Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  });
  return (
    <Parsed result={result} file={props.file} strings={props.strings}>
      {(rows) => <Table rows={rows} maxRows={props.maxRows} strings={props.strings} />}
    </Parsed>
  );
}

function SheetView(props: FileBodyProps) {
  const [active, setActive] = useState(0);
  const result = useParsed(props.bytes, async (bytes) => {
    const readXlsxFile = (await import("read-excel-file/browser")).default;
    const copy = bytes.slice();
    return readXlsxFile(copy.buffer as ArrayBuffer);
  });
  return (
    <Parsed result={result} file={props.file} strings={props.strings}>
      {(sheets) => (
        <div className="viewer-sheets">
          {sheets.length > 1 ? (
            <div className="viewer-tabs" role="tablist">
              {sheets.map((s, i) => (
                <button
                  key={s.sheet}
                  type="button"
                  role="tab"
                  aria-selected={i === active}
                  className={cx(i === active && "on")}
                  onClick={() => setActive(i)}
                >
                  {s.sheet}
                </button>
              ))}
            </div>
          ) : null}
          <Table
            rows={sheets[active]?.data ?? []}
            maxRows={props.maxRows}
            strings={props.strings}
          />
        </div>
      )}
    </Parsed>
  );
}

function ZipView(props: FileBodyProps) {
  const result = useParsed(props.bytes, async (bytes) => {
    const { unzipSync } = await import("fflate");
    const entries: { name: string; size: number }[] = [];
    // Listed, never extracted: the filter sees every entry and keeps none.
    unzipSync(bytes, {
      filter: (f) => {
        entries.push({ name: f.name, size: f.originalSize });
        return false;
      },
    });
    return entries.filter((e) => !e.name.endsWith("/"));
  });
  return (
    <Parsed result={result} file={props.file} strings={props.strings}>
      {(entries) => (
        <div className="viewer-zip">
          <div className="viewer-more">{fill(props.strings.zipFiles, { n: entries.length })}</div>
          <ul>
            {entries.map((e) => (
              <li key={e.name}>
                <span>{e.name}</span>
                <span className="sz">{formatSize(e.size)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Parsed>
  );
}

function EmailView(props: FileBodyProps) {
  const result = useParsed(props.bytes, async (bytes) => {
    const PostalMime = (await import("postal-mime")).default;
    const email = await PostalMime.parse(bytes.slice().buffer as ArrayBuffer);
    let text = email.text ?? "";
    if (!text && email.html) {
      // The HTML part as text: nothing in an attached message renders or runs.
      const doc = new DOMParser().parseFromString(email.html, "text/html");
      text = doc.body.textContent ?? "";
    }
    const who = (a: { name?: string; address?: string } | undefined) =>
      a ? (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")) : "";
    return {
      subject: email.subject ?? "",
      from: who(email.from as { name?: string; address?: string } | undefined),
      to: (email.to ?? []).map((a) => who(a as { name?: string; address?: string })).join(", "),
      date: email.date ?? "",
      text: text.trim(),
    };
  });
  return (
    <Parsed result={result} file={props.file} strings={props.strings}>
      {(m) => (
        <div className="viewer-email">
          <h3>{m.subject}</h3>
          <dl>
            <dt>{props.strings.from}</dt>
            <dd>{m.from}</dd>
            <dt>{props.strings.to}</dt>
            <dd>{m.to}</dd>
            <dt>{props.strings.date}</dt>
            <dd>{m.date ? new Date(m.date).toLocaleString() : ""}</dd>
          </dl>
          <pre className="viewer-text wrap">
            <code>{m.text}</code>
          </pre>
        </div>
      )}
    </Parsed>
  );
}

function DocxView(props: FileBodyProps) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ error?: string; done?: boolean }>({});
  useEffect(() => {
    let live = true;
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    import("docx-preview")
      .then(({ renderAsync }) =>
        renderAsync(new Blob([props.bytes as BlobPart]), el, undefined, {
          inWrapper: false,
          breakPages: true,
          ignoreLastRenderedPageBreak: true,
          experimental: false,
          renderHeaders: true,
          renderFooters: true,
        }),
      )
      .then(() => live && setState({ done: true }))
      .catch(
        (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [props.bytes]);
  return (
    <div className="viewer-docx">
      {state.error !== undefined ? (
        <Notice
          text={fill(props.strings.failed, { name: props.file.name, message: state.error })}
        />
      ) : !state.done ? (
        <Notice text={fill(props.strings.loading, { name: props.file.name })} busy />
      ) : null}
      <div ref={host} className="viewer-docx-pages" />
    </div>
  );
}

function PdfView(props: FileBodyProps) {
  const host = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let destroy: (() => void) | null = null;
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    void (async () => {
      try {
        const { openPdf } = await import("./pdf.ts");
        const pdf = await openPdf(props.bytes);
        destroy = () => pdf.destroy();
        if (!live) return;
        setPages(pdf.pages);
        const width = Math.min(el.clientWidth - 32, 1000) || 800;
        // Page after page, so the first one shows while the rest draw.
        for (let n = 1; n <= pdf.pages && live; n++) {
          const canvas = await pdf.render(n, width);
          if (!live) return;
          canvas.className = "viewer-page";
          el.append(canvas);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      destroy?.();
    };
  }, [props.bytes]);
  return (
    <div className="viewer-pdf">
      {error !== null ? (
        <Notice text={fill(props.strings.failed, { name: props.file.name, message: error })} />
      ) : pages === 0 ? (
        <Notice text={fill(props.strings.loading, { name: props.file.name })} busy />
      ) : (
        <div className="viewer-more">{fill(props.strings.pageOf, { total: pages })}</div>
      )}
      <div ref={host} className="viewer-pages" />
    </div>
  );
}
