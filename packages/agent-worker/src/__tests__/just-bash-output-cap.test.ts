import { describe, expect, test } from "bun:test";
import { capEmbeddedBashStreamOutput } from "../embedded/just-bash-bootstrap";

describe("capEmbeddedBashStreamOutput", () => {
  test("leaves small stdout unchanged", () => {
    expect(capEmbeddedBashStreamOutput("stdout", "hello", 10)).toBe("hello");
  });

  test("truncates large stdout with shell guidance", () => {
    const out = capEmbeddedBashStreamOutput("stdout", "x".repeat(50), 10);
    expect(out).toContain("x".repeat(10));
    expect(out).toContain("[stdout truncated: 50 chars > 10");
    expect(out).toContain("sed -n");
    expect(out).toContain("rg");
  });

  test("truncates large stderr and labels stderr", () => {
    const out = capEmbeddedBashStreamOutput("stderr", "e".repeat(50), 10);
    expect(out).toContain("[stderr truncated: 50 chars > 10");
  });
});
