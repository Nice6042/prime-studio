/** Minimal Node declarations for test-only fixture loading; app dependencies stay browser-only. */
declare module "node:fs" {
  export interface FileBytes extends Uint8Array {
    toString(encoding?: string): string;
  }

  export interface DirectoryEntry {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }

  export function readFileSync(path: string): FileBytes;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function readdirSync(path: string, options: { withFileTypes: true }): DirectoryEntry[];
}

declare module "node:path" {
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare const process: {
  cwd(): string;
};
