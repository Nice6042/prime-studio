import {
  MAX_PROJECT_CHAT_JSON_BYTES,
  utf8ByteLengthWithin,
} from "./validation";

const MAX_JSON_DEPTH = 512;

class JsonKeyScanner {
  private index = 0;

  public constructor(private readonly source: string) {}

  public scan(): boolean {
    this.skipWhitespace();
    if (!this.scanValue(0)) return false;
    this.skipWhitespace();
    return this.index === this.source.length;
  }

  private scanValue(depth: number): boolean {
    if (depth > MAX_JSON_DEPTH) return false;
    this.skipWhitespace();
    const character = this.source[this.index];
    if (character === "{") return this.scanObject(depth + 1);
    if (character === "[") return this.scanArray(depth + 1);
    if (character === '"') return this.scanString() !== null;
    if (character === "t") return this.scanLiteral("true");
    if (character === "f") return this.scanLiteral("false");
    if (character === "n") return this.scanLiteral("null");
    return this.scanNumber();
  }

  private scanObject(depth: number): boolean {
    this.index += 1;
    this.skipWhitespace();
    const keys = new Set<string>();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return true;
    }

    while (this.index < this.source.length) {
      const key = this.scanString();
      if (key === null || keys.has(key)) return false;
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.index] !== ":") return false;
      this.index += 1;
      if (!this.scanValue(depth)) return false;
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return true;
      }
      if (this.source[this.index] !== ",") return false;
      this.index += 1;
      this.skipWhitespace();
    }
    return false;
  }

  private scanArray(depth: number): boolean {
    this.index += 1;
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return true;
    }

    while (this.index < this.source.length) {
      if (!this.scanValue(depth)) return false;
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return true;
      }
      if (this.source[this.index] !== ",") return false;
      this.index += 1;
      this.skipWhitespace();
    }
    return false;
  }

  private scanString(): string | null {
    const start = this.index;
    if (this.source[this.index] !== '"') return null;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        try {
          const parsed = JSON.parse(this.source.slice(start, this.index)) as unknown;
          return typeof parsed === "string" ? parsed : null;
        } catch {
          return null;
        }
      }
      if (code < 0x20) return null;
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.source[this.index];
        if ('"\\/bfnrt'.includes(escape)) {
          this.index += 1;
          continue;
        }
        if (escape !== "u") return null;
        for (let offset = 1; offset <= 4; offset += 1) {
          if (!/[0-9a-fA-F]/.test(this.source[this.index + offset] ?? "")) {
            return null;
          }
        }
        this.index += 5;
        continue;
      }
      this.index += 1;
    }
    return null;
  }

  private scanLiteral(literal: string): boolean {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) {
      return false;
    }
    this.index += literal.length;
    return true;
  }

  private scanNumber(): boolean {
    const start = this.index;
    if (this.source[this.index] === "-") this.index += 1;

    if (this.source[this.index] === "0") {
      this.index += 1;
    } else {
      if (!/[1-9]/.test(this.source[this.index] ?? "")) return false;
      while (/[0-9]/.test(this.source[this.index] ?? "")) this.index += 1;
    }

    if (this.source[this.index] === ".") {
      this.index += 1;
      if (!/[0-9]/.test(this.source[this.index] ?? "")) return false;
      while (/[0-9]/.test(this.source[this.index] ?? "")) this.index += 1;
    }

    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      this.index += 1;
      if (this.source[this.index] === "+" || this.source[this.index] === "-") {
        this.index += 1;
      }
      if (!/[0-9]/.test(this.source[this.index] ?? "")) return false;
      while (/[0-9]/.test(this.source[this.index] ?? "")) this.index += 1;
    }

    return this.index > start;
  }

  private skipWhitespace(): void {
    while (
      this.source[this.index] === " " ||
      this.source[this.index] === "\t" ||
      this.source[this.index] === "\n" ||
      this.source[this.index] === "\r"
    ) {
      this.index += 1;
    }
  }
}

export function hasStrictJsonObjectKeys(value: unknown): boolean {
  try {
    return (
      typeof value === "string" &&
      utf8ByteLengthWithin(value, MAX_PROJECT_CHAT_JSON_BYTES) !== undefined &&
      new JsonKeyScanner(value).scan()
    );
  } catch {
    return false;
  }
}
