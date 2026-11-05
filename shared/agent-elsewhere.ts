/**
 * An agent run by another AnviDeck server sharing the agent registry (#104). Only that server
 * can stop it, answer it or send it a message; this one lists it and says where it is. One
 * wording for the server's refusals and the pages.
 */

export interface RunsElsewhere {
  pid: number;
  port?: number;
}

export function elsewhereText(o: RunsElsewhere): string {
  return `it runs in another AnviDeck server (${o.port !== undefined ? `port ${o.port}, ` : ""}pid ${o.pid})`;
}

/** Where to open that server's page, from this page's own address (same host, its port). */
export function elsewhereUrl(o: RunsElsewhere, here: { protocol: string; hostname: string }, hash = ""): string | null {
  if (o.port === undefined) return null;
  const host = here.hostname.includes(":") ? `[${here.hostname}]` : here.hostname;
  return `${here.protocol}//${host}:${o.port}/${hash}`;
}
