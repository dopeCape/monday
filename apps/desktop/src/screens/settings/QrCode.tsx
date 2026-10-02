// A QR code as an SVG drawn in code (qrcode-generator does the encoding, no
// network and no canvas). One path of dark modules, runs merged per row, on
// the QR paper token with the quiet zone the standard asks for.

import qrcode from "qrcode-generator";

/** Modules of the quiet zone around the code. */
const QUIET = 4;

/** The dark modules, row by row. Medium error correction survives a glare or a crease. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => qr.isDark(row, col)),
  );
}

/** The SVG path of the dark modules, offset by the quiet zone, horizontal runs merged. */
export function qrPath(modules: readonly (readonly boolean[])[]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < row.length && row[end]) end++;
      parts.push(`M${x + QUIET} ${y + QUIET}h${end - x}v1h${x - end}z`);
      x = end;
    }
  });
  return parts.join("");
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const modules = qrModules(text);
  const size = modules.length + QUIET * 2;
  return (
    <svg
      className="qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
      data-qr={text}
    >
      <rect width={size} height={size} fill="var(--qr-paper)" />
      <path d={qrPath(modules)} fill="var(--qr-ink)" />
    </svg>
  );
}
