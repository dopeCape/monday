// Vercel builds every file under api/ as a function; this one is the whole
// server. vercel.json rewrites every path here. See entry/vercel.ts.

export { config, default } from "../entry/vercel.ts";
