/**
 * Demo data embedded by the standalone single-file build.
 *
 * A page opened with file:// cannot fetch sibling files, so the standalone
 * build inlines the demo dataset onto `window` instead. Absent in the normal
 * server-served build, where the files are fetched.
 */
declare global {
  interface Window {
    __DEMO_DATA__?: {
      table: string;
      taxonomy: string;
      metadata: string;
    };
  }
}

export {};
