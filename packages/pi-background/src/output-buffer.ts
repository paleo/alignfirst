import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

export const OUTPUT_LIMIT = 1024 * 1024;

export interface OutputBuffer {
  append: (stream: "stdout" | "stderr", chunk: Buffer) => void;
  finish: () => void;
  metadata: () => OutputMetadata;
  read: (maxBytes: number) => OutputSnapshot;
}

export interface OutputSnapshot extends OutputMetadata {
  output: string;
  returnedBytes: number;
}

export interface OutputMetadata {
  outputBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export function createOutputBuffer(): OutputBuffer {
  const ring = Buffer.alloc(OUTPUT_LIMIT);
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let cursor = 0;
  let retainedBytes = 0;
  let outputBytes = 0;
  let decodedBytes = 0;
  let finished = false;
  const store = (text: string) => {
    const bytes = Buffer.from(text);
    decodedBytes += bytes.length;
    const tail = bytes.subarray(Math.max(0, bytes.length - OUTPUT_LIMIT));
    const first = Math.min(tail.length, OUTPUT_LIMIT - cursor);
    tail.copy(ring, cursor, 0, first);
    tail.copy(ring, 0, first);
    cursor = (cursor + tail.length) % OUTPUT_LIMIT;
    retainedBytes = Math.min(OUTPUT_LIMIT, retainedBytes + tail.length);
  };
  const metadata = () => ({
    outputBytes,
    retainedBytes,
    truncated: decodedBytes > retainedBytes,
  });
  return {
    append(stream, chunk) {
      if (finished) return;
      outputBytes += chunk.length;
      store(decoders[stream].write(chunk));
    },
    finish() {
      if (finished) return;
      finished = true;
      store(decoders.stdout.end());
      store(decoders.stderr.end());
    },
    metadata,
    read(maxBytes) {
      const length = Math.min(maxBytes, retainedBytes);
      const start = (cursor - length + OUTPUT_LIMIT) % OUTPUT_LIMIT;
      const bytes = Buffer.alloc(length);
      const first = Math.min(length, OUTPUT_LIMIT - start);
      ring.copy(bytes, 0, start, start + first);
      ring.copy(bytes, first, 0, length - first);
      let cut = 0;
      while (cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) ++cut;
      const output = sanitize(bytes.subarray(cut).toString("utf8"));
      return {
        ...metadata(),
        output,
        returnedBytes: Buffer.byteLength(output),
        truncated: decodedBytes > length || cut > 0,
      };
    },
  };
}

export function sanitize(text: string): string {
  return [...stripVTControlCharacters(text)]
    .filter((character) => {
      const code = character.codePointAt(0);
      if (code === undefined) return false;
      return (
        code === 9 ||
        code === 10 ||
        (code >= 32 && !(code >= 127 && code <= 159) && !(code >= 0xfff9 && code <= 0xfffb))
      );
    })
    .join("");
}

export function preview(text: string, maxBytes: number): string {
  const clean = sanitize(text);
  const bytes = Buffer.from(clean);
  if (bytes.length <= maxBytes) return clean;
  const decoder = new StringDecoder("utf8");
  return `${decoder.write(bytes.subarray(0, maxBytes))}…[preview]`;
}
