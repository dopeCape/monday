// The Netlify Scheduled Function: the Job tick every minute, 30 s budget
// (https://docs.netlify.com/build/functions/scheduled-functions/). Runs only
// on published production deploys. See entry/netlify.ts.

import { tick } from "../netlify.ts";

export default async function handler(): Promise<Response> {
  return tick();
}

export const config = { schedule: "* * * * *" };
