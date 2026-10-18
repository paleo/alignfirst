import { describe, expect, it } from "vitest";
import { createOutputBuffer, OUTPUT_LIMIT, preview } from "../src/output-buffer.js";

describe("bounded byte-tail output", () => {
  it("decodes split UTF-8 independently on stdout/stderr and interleaves decoded arrivals", () => {
    const output = createOutputBuffer();
    const bytes = Buffer.from("😀日本語");
    output.append("stdout", bytes.subarray(0, 2));
    output.append("stderr", Buffer.from("error"));
    output.append("stdout", bytes.subarray(2));
    output.finish();
    expect(output.read(16384)).toEqual({
      output: "error😀日本語",
      outputBytes: 18,
      retainedBytes: 18,
      returnedBytes: 18,
      truncated: false,
    });
  });
  it("bounds even a single oversized chunk and cuts on a UTF-8 boundary", () => {
    const output = createOutputBuffer();
    const bytes = Buffer.from("😀".repeat(OUTPUT_LIMIT));
    output.append("stdout", bytes);
    output.finish();
    expect(output.metadata()).toEqual({
      outputBytes: bytes.length,
      retainedBytes: OUTPUT_LIMIT,
      truncated: true,
    });
    expect(output.read(5)).toEqual({
      output: "😀",
      returnedBytes: 4,
      outputBytes: bytes.length,
      retainedBytes: OUTPUT_LIMIT,
      truncated: true,
    });
    expect(output.read(51200).output).not.toContain("�");
  });
  it("wraps the ring, maintains byte counts, and sanitizes terminal controls", () => {
    const output = createOutputBuffer();
    for (let i = 0; i < 70; ++i) output.append("stdout", Buffer.alloc(16384, 97));
    output.append(
      "stderr",
      Buffer.from("\u001b[31mRED\u001b[0m\u001b]52;c;SECRET\u0007\r\u0000\u009b\uFFF9\n"),
    );
    output.finish();
    const snapshot = output.read(100);
    expect(snapshot.retainedBytes).toBe(OUTPUT_LIMIT);
    expect(snapshot.output.endsWith("RED\n")).toBe(true);
    for (const forbidden of ["SECRET", "\u001b", "\u0000", "\r", "\u009b", "\uFFF9"]) {
      expect(snapshot.output).not.toContain(forbidden);
    }
    expect(Buffer.byteLength(snapshot.output)).toBe(snapshot.returnedBytes);
    expect(snapshot.truncated).toBe(true);
  });
  it("marks metadata previews explicitly without splitting characters", () => {
    expect(preview("😀".repeat(100), 5)).toBe("😀…[preview]");
  });
});
