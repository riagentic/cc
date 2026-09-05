/**
 * Types for the vendored bundle.
 *
 * The bundle is generated JavaScript, so the types it lost on the way through
 * esbuild are declared here. Deliberately narrow: only the surface this app
 * uses, because a hand-written declaration that claims more than it has tested
 * is worse than none.
 */
export interface TerminalTheme {
  [key: string]: string;
}

export interface TerminalOptions {
  allowProposedApi?: boolean;
  fontSize?: number;
  fontFamily?: string;
  lineHeight?: number;
  cursorBlink?: boolean;
  scrollback?: number;
  macOptionIsMeta?: boolean;
  theme?: TerminalTheme;
}

export interface Disposable {
  dispose(): void;
}

export class Terminal {
  constructor(options?: TerminalOptions);
  readonly rows: number;
  readonly cols: number;
  options: { theme?: TerminalTheme };
  open(parent: HTMLElement): void;
  write(data: string): void;
  focus(): void;
  dispose(): void;
  onData(handler: (data: string) => void): Disposable;
  // deno-lint-ignore no-explicit-any
  loadAddon(addon: any): void;
}

export class FitAddon {
  fit(): void;
}
