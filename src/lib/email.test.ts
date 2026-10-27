// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isEmail, mailto } from "./email";

describe("isEmail", () => {
  it("accepts ordinary addresses", () => {
    for (const e of ["jane@acme.com", "jane.doe+pay@mail.acme.co.uk", " jane@acme.io "]) expect(isEmail(e)).toBe(true);
  });
  it("rejects anything a mailto: link can't use", () => {
    for (const e of ["", null, undefined, "n/a", "jane@", "@acme.com", "jane@acme", "jane doe@acme.com", "a@b.c", "jane@acme.com?cc=x@y.com", "a@b@c.com"]) expect(isEmail(e)).toBe(false);
  });
});

describe("mailto", () => {
  it("trims the address", () => expect(mailto(" jane@acme.com ")).toBe("mailto:jane@acme.com"));
});
