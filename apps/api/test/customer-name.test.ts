import { describe, expect, it } from "vitest";
import { parseCustomerName } from "@gestion/shared";

describe("parseCustomerName", () => {
  it.each([
    ["accents", "María José", "María José"],
    ["an apostrophe", "O'Brien", "O'Brien"],
    ["non-Latin letters", "李雷", "李雷"],
    ["the minimum length (2)", "Al", "Al"],
    ["the maximum length (60)", "a".repeat(60), "a".repeat(60)],
    ["padding and runs of spaces", "  Ana   Pérez ", "Ana Pérez"],
    ["a line break and a tab between words", "Ana\n\tPérez", "Ana Pérez"],
  ])("accepts %s", (_label, raw, expected) => {
    expect(parseCustomerName(raw)).toBe(expected);
  });

  it.each([
    ["one character", "A"],
    ["61 characters", "a".repeat(61)],
    ["an emoji", "Ana 😀"],
    ["a digit", "Ana2"],
    ["a NUL character", "Ana\u0000"],
    ["a right-to-left override", "Ana\u202Eevil"],
    ["a zero-width space", "An\u200Ba"],
    ["a leading hyphen", "-Ana"],
    ["a leading apostrophe", "'Ana"],
    ["markup", "<b>Ana</b>"],
    ["an SQL fragment", "Robert'); DROP TABLE customers;--"],
    ["an e-mail address", "ana@x.com"],
    ["an underscore", "Ana_P"],
    ["an empty text", ""],
  ])("rejects %s", (_label, raw) => {
    expect(parseCustomerName(raw)).toBeNull();
  });
});
