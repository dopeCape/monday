// Which viewer an attachment opens in, from its media type and its name. Mail
// clients label parts loosely (a PDF as application/octet-stream, a CSV as
// text/plain), so the extension settles what the media type leaves open.

export type ViewerKind =
  | "image"
  | "pdf"
  | "docx"
  | "sheet"
  | "csv"
  | "markdown"
  | "text"
  | "audio"
  | "video"
  | "zip"
  | "email"
  | "none";

const TEXT_EXTENSIONS = new Set([
  "txt",
  "log",
  "json",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "ics",
  "vcf",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "h",
  "cpp",
  "cs",
  "sh",
  "sql",
  "css",
  "html",
  "htm",
]);

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "m4v", "ogv"]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function viewerKind(name: string, mediaType: string): ViewerKind {
  const type = mediaType.toLowerCase().split(";")[0]?.trim() ?? "";
  const ext = extensionOf(name);
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (
    type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === "docx"
  ) {
    return "docx";
  }
  if (
    type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    ext === "xlsx"
  ) {
    return "sheet";
  }
  if (
    type === "text/csv" ||
    type === "text/tab-separated-values" ||
    ext === "csv" ||
    ext === "tsv"
  ) {
    return "csv";
  }
  if (type === "message/rfc822" || ext === "eml") return "email";
  if (type === "application/zip" || type === "application/x-zip-compressed" || ext === "zip") {
    return "zip";
  }
  if (type === "text/markdown" || ext === "md" || ext === "markdown") return "markdown";
  if (type.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (type.startsWith("audio/") || AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (type.startsWith("video/") || VIDEO_EXTENSIONS.has(ext)) return "video";
  if (
    type.startsWith("text/") ||
    type === "application/json" ||
    type === "application/xml" ||
    type === "application/x-yaml" ||
    type === "text/calendar" ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    return "text";
  }
  return "none";
}

/** The media type a viewer should hand the webview: the part's own, unless it is the generic one. */
export function displayType(name: string, mediaType: string): string {
  const type = mediaType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type && type !== "application/octet-stream") return type;
  const ext = extensionOf(name);
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return byExt[ext] ?? "application/octet-stream";
}
