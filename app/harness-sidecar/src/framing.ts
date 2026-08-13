const FRAME_MAX_BYTES = 4 * 1024 * 1024;

class JsonSyntaxCursor {
  readonly #source: string;
  #offset = 0;

  constructor(source: string) {
    this.#source = source;
  }

  parse(): void {
    this.#skipWhitespace();
    this.#parseValue();
    this.#skipWhitespace();
    if (this.#offset !== this.#source.length) throw new SyntaxError("unexpected JSON trailing data");
  }

  #parseValue(): void {
    const current = this.#source[this.#offset];
    if (current === "{") return this.#parseObject();
    if (current === "[") return this.#parseArray();
    if (current === '"') { this.#parseString(); return; }
    if (current === "-" || (current !== undefined && current >= "0" && current <= "9")) {
      this.#parseNumber();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (this.#source.startsWith(literal, this.#offset)) {
        this.#offset += literal.length;
        return;
      }
    }
    throw new SyntaxError(`invalid JSON value at offset ${this.#offset}`);
  }

  #parseObject(): void {
    this.#offset += 1;
    this.#skipWhitespace();
    const keys = new Set<string>();
    if (this.#take("}")) return;
    for (;;) {
      if (this.#source[this.#offset] !== '"') throw new SyntaxError("JSON object key must be a string");
      const key = this.#parseString();
      if (keys.has(key)) throw new SyntaxError(`duplicate JSON key: ${key}`);
      keys.add(key);
      this.#skipWhitespace();
      this.#expect(":");
      this.#skipWhitespace();
      this.#parseValue();
      this.#skipWhitespace();
      if (this.#take("}")) return;
      this.#expect(",");
      this.#skipWhitespace();
    }
  }

  #parseArray(): void {
    this.#offset += 1;
    this.#skipWhitespace();
    if (this.#take("]")) return;
    for (;;) {
      this.#parseValue();
      this.#skipWhitespace();
      if (this.#take("]")) return;
      this.#expect(",");
      this.#skipWhitespace();
    }
  }

  #parseString(): string {
    const start = this.#offset;
    this.#expect('"');
    while (this.#offset < this.#source.length) {
      const character = this.#source[this.#offset];
      if (character === '"') {
        this.#offset += 1;
        return JSON.parse(this.#source.slice(start, this.#offset)) as string;
      }
      if (character === "\\") {
        this.#offset += 1;
        if (this.#source[this.#offset] === "u") {
          const digits = this.#source.slice(this.#offset + 1, this.#offset + 5);
          if (!/^[a-fA-F0-9]{4}$/.test(digits)) throw new SyntaxError("invalid JSON unicode escape");
          this.#offset += 5;
          continue;
        }
        if (!'"\\/bfnrt'.includes(this.#source[this.#offset] ?? "")) throw new SyntaxError("invalid JSON escape");
        this.#offset += 1;
        continue;
      }
      if (character === undefined || character.charCodeAt(0) < 0x20) throw new SyntaxError("invalid JSON string");
      this.#offset += 1;
    }
    throw new SyntaxError("unterminated JSON string");
  }

  #parseNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.#source.slice(this.#offset));
    if (!match) throw new SyntaxError("invalid JSON number");
    this.#offset += match[0].length;
  }

  #skipWhitespace(): void {
    while (/\s/.test(this.#source[this.#offset] ?? "") && this.#offset < this.#source.length) this.#offset += 1;
  }

  #expect(value: string): void {
    if (!this.#take(value)) throw new SyntaxError(`expected ${value} at offset ${this.#offset}`);
  }

  #take(value: string): boolean {
    if (!this.#source.startsWith(value, this.#offset)) return false;
    this.#offset += value.length;
    return true;
  }
}

export function parseClosedJson(source: string): unknown {
  new JsonSyntaxCursor(source).parse();
  return JSON.parse(source) as unknown;
}

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > FRAME_MAX_BYTES) throw new RangeError("frame exceeds protocol limit");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function decodeFrame(frame: Uint8Array): unknown {
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.length < 4) throw new RangeError("frame length prefix is incomplete");
  const length = bytes.readUInt32BE(0);
  if (length === 0 || length > FRAME_MAX_BYTES || bytes.length !== length + 4) {
    throw new RangeError("frame length is invalid");
  }
  return parseClosedJson(bytes.subarray(4).toString("utf8"));
}

export class FrameStreamDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    if (this.#buffer.length > FRAME_MAX_BYTES + 4) throw new RangeError("frame exceeds protocol limit");
    const frames: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > FRAME_MAX_BYTES) throw new RangeError("frame length is invalid");
      if (this.#buffer.length < length + 4) break;
      const frame = this.#buffer.subarray(0, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      frames.push(decodeFrame(frame));
    }
    return frames;
  }
}
