// A Message's HTML body in a sandboxed iframe (mail-frame.ts has the
// document): no scripts, the app's styles kept out and the Message's kept
// in, its height fitted to the content, links handed to the opener, inline
// parts resolved with the device token, remote images shown on request.

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  appLook,
  appScheme,
  BLOCKED_MARK,
  carryFonts,
  carryHostStyle,
  contentHeight,
  mailDocument,
  QUOTED_MARK,
  revealImages,
} from "./mail-frame.ts";
import { Btn } from "./primitives.tsx";

export interface HtmlBodyStrings {
  showQuoted: string;
  hideQuoted: string;
  showImages: string;
  /** The frame's accessible name. */
  frameTitle: string;
}

export interface HtmlBodyProps {
  html: string;
  collapseQuoted: boolean;
  /** Remote images load from the start (the reader.load_remote_images Setting). */
  loadRemoteImages?: boolean | undefined;
  strings: HtmlBodyStrings;
  onOpenLink: ((href: string) => void) | undefined;
  attachmentSrc: ((attachmentId: string) => Promise<string>) | undefined;
}

/** Wires one loaded document: look, fonts, images, inline parts, links, height. Returns the teardown. */
function prepare(
  frame: HTMLIFrameElement,
  doc: Document,
  options: {
    host: Element | null;
    images: boolean;
    quotedOpen: boolean;
    openLink: (href: string) => void;
    attachmentSrc: ((attachmentId: string) => Promise<string>) | undefined;
  },
): () => void {
  let done = false;
  const urls: string[] = [];
  carryHostStyle(options.host, doc);
  carryFonts(doc);
  doc.documentElement.setAttribute("data-quoted", options.quotedOpen ? "open" : "collapsed");
  if (options.images) revealImages(doc);

  const fit = () => {
    if (done) return;
    const height = contentHeight(doc);
    if (height > 0) frame.style.height = `${height}px`;
  };

  for (const img of doc.querySelectorAll<HTMLImageElement>("img[data-attachment]")) {
    const id = img.getAttribute("data-attachment") ?? "";
    img.removeAttribute("data-attachment");
    if (!options.attachmentSrc || !id) continue;
    void options
      .attachmentSrc(decodeURIComponent(id))
      .then((url) => {
        if (done) {
          if (url.startsWith("blob:")) URL.revokeObjectURL?.(url);
          return;
        }
        urls.push(url);
        img.setAttribute("src", url);
        fit();
      })
      .catch(() => {});
  }

  const onClick = (e: Event) => {
    const target = (e.target as Element | null)?.closest?.("a[href]");
    if (!target) return;
    e.preventDefault();
    const href = target.getAttribute("href");
    if (href) options.openLink(href);
  };
  // Capture, so the link never navigates the frame whatever the body does below.
  doc.addEventListener("click", onClick, true);
  doc.addEventListener("auxclick", onClick, true);
  // Images and late fonts change the height; so does the reader's width.
  doc.addEventListener("load", fit, true);
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  const Observer = view?.ResizeObserver ?? globalThis.ResizeObserver;
  const observer = Observer ? new Observer(() => fit()) : null;
  const scope = doc.querySelector(".monday-mail");
  if (observer && scope) observer.observe(scope);
  fit();
  return () => {
    done = true;
    observer?.disconnect();
    doc.removeEventListener("click", onClick, true);
    doc.removeEventListener("auxclick", onClick, true);
    doc.removeEventListener("load", fit, true);
    for (const url of urls) if (url.startsWith("blob:")) URL.revokeObjectURL?.(url);
  };
}

/** Sanitised HTML from the Server in its own document, with folded history, blocked images and intercepted links. */
export function HtmlBody({
  html,
  collapseQuoted,
  loadRemoteImages,
  strings,
  onOpenLink,
  attachmentSrc,
}: HtmlBodyProps): ReactNode {
  const hasQuoted = html.includes(QUOTED_MARK);
  const hasBlocked = html.includes(BLOCKED_MARK);
  const [quotedOpen, setQuotedOpen] = useState(!collapseQuoted);
  const [imagesShown, setImagesShown] = useState(loadRemoteImages ?? false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const srcDoc = useMemo(
    () => mailDocument(html, { images: imagesShown, scheme: appScheme(), look: appLook() }),
    [html, imagesShown],
  );
  // The latest callbacks and fold state, read when a document loads.
  const openRef = useRef(onOpenLink);
  openRef.current = onOpenLink;
  const quotedRef = useRef(quotedOpen);
  quotedRef.current = quotedOpen;
  const attachmentRef = useRef(attachmentSrc);
  attachmentRef.current = attachmentSrc;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !srcDoc) return;
    let teardown: (() => void) | null = null;
    const onLoad = () => {
      teardown?.();
      teardown = null;
      const doc = frame.contentDocument;
      if (!doc?.querySelector(".monday-mail")) return;
      teardown = prepare(frame, doc, {
        host: hostRef.current,
        images: imagesShown,
        quotedOpen: quotedRef.current,
        openLink: (href) => openRef.current?.(href),
        attachmentSrc: attachmentRef.current
          ? (id) => attachmentRef.current?.(id) ?? Promise.reject(new Error("no attachments"))
          : undefined,
      });
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      teardown?.();
    };
  }, [srcDoc, imagesShown]);

  // Folding and unfolding the history needs no reload, only a new height.
  useEffect(() => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement) return;
    doc.documentElement.setAttribute("data-quoted", quotedOpen ? "open" : "collapsed");
    const height = contentHeight(doc);
    if (height > 0) frame.style.height = `${height}px`;
  }, [quotedOpen]);

  return (
    <>
      <div
        ref={hostRef}
        className="msg-body msg-html"
        data-quoted={hasQuoted ? (quotedOpen ? "open" : "collapsed") : undefined}
      >
        <iframe
          ref={frameRef}
          className="msg-frame"
          title={strings.frameTitle}
          sandbox="allow-same-origin allow-popups"
          srcDoc={srcDoc}
        />
      </div>
      {hasQuoted || (hasBlocked && !imagesShown) ? (
        <div className="msg-more">
          {hasQuoted ? (
            <Btn sm onClick={() => setQuotedOpen((o) => !o)}>
              {quotedOpen ? strings.hideQuoted : strings.showQuoted}
            </Btn>
          ) : null}
          {hasBlocked && !imagesShown ? (
            <Btn sm onClick={() => setImagesShown(true)}>
              {strings.showImages}
            </Btn>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
