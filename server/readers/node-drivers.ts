/**
 * The two small CommonJS drivers that load anvi's own scripts in node (structure-driver.cjs,
 * refusals-driver.cjs), carried inside AnviDeck as text.
 *
 * Why as text: in the desktop app the server is one compiled binary (`bun build --compile`), and
 * a file beside the source is not on disk there (`/$bunfs/root/...`), so `node <path>` cannot
 * open it (#240). The text is imported here, so the compiler embeds it, and node reads it on
 * stdin (`node - <args>`). Under `node -` the arguments keep their places (process.argv[2] is
 * still the first one), so the drivers run unchanged, from source and from the binary alike.
 */
import structureDriver from "./structure-driver.cjs" with { type: "text" };
import refusalsDriver from "./refusals-driver.cjs" with { type: "text" };

export const DRIVER_SOURCES = { structure: structureDriver, refusals: refusalsDriver } as const;
export type DriverName = keyof typeof DRIVER_SOURCES;

/** node's arguments to run a driver: its source comes on stdin, the arguments keep their places. */
export function driverArgs(args: string[]): string[] {
  return ["-", ...args];
}

/**
 * Hand the driver's source to a node child spawned with stdin "pipe". A child that dies before
 * reading it (node missing, killed) would raise EPIPE on the pipe; that is reported by the
 * child's own exit, so the pipe error is swallowed here and never thrown.
 */
export function feedDriver(stdin: NodeJS.WritableStream | null | undefined, name: DriverName): void {
  if (!stdin) return;
  stdin.on("error", () => {});
  stdin.end(DRIVER_SOURCES[name]);
}
