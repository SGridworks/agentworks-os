import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  signPdf,
  verifyPdfSignature,
  REVOKED_KEY_IDS,
} from "./evidence-report-signing.js";

describe("evidence-report signing — key revocation", () => {
  it("includes the leaked v1 keyId in REVOKED_KEY_IDS", () => {
    expect(REVOKED_KEY_IDS.has("bed588cd")).toBe(true);
  });

  it("rejects a signature claiming a revoked keyId before any other check", () => {
    // The leaked secret could be used by a third party to mint a forged
    // signature whose HMAC actually validates. Revocation must therefore
    // fire on keyId alone, before HMAC verification, so a forgery from
    // the leaked key is rejected even when the hash checks would pass.
    const pdf = Buffer.from("%PDF-1.4\nfake\n%%EOF\n");
    const sig = {
      alg: "HS256",
      pdfHash: "0".repeat(64),
      reportId: "r",
      ts: "2026-05-03T00:00:00.000Z",
      keyId: "bed588cd",
      hmac: "irrelevant-because-revocation-fires-first",
    };
    const trailer = `\n<!--sig-->${JSON.stringify(sig)}<!--sig-->\n`;
    const tampered = Buffer.concat([pdf, Buffer.from(trailer, "utf8")]);

    // Revocation must fire before key load, so an empty/nonexistent keyDir
    // still throws "revoked", not "key not found".
    const emptyKeyDir = mkdtempSync(join(tmpdir(), "awos-sig-revoked-"));
    expect(() => verifyPdfSignature(tampered, emptyKeyDir)).toThrow(/revoked/i);
  });
});

describe("evidence-report signing — sign/verify round trip", () => {
  let keyDir: string;

  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), "awos-sig-"));
  });

  it("verifies a freshly signed PDF and returns matching SignatureInfo", () => {
    const fakePdf = Buffer.from("%PDF-1.4\nfake content\n%%EOF\n");
    const signed = signPdf(
      fakePdf,
      "report-123",
      keyDir,
      () => new Date("2026-05-03T00:00:00.000Z"),
    );

    const sig = verifyPdfSignature(signed.pdfBytes, keyDir);

    expect(sig.pdfHash).toBe(signed.pdfHash);
    expect(sig.reportId).toBe("report-123");
    expect(sig.alg).toBe("HS256");
    expect(sig.keyId).toBeTruthy();
  });

  it("throws on tampered pre-trailer content", () => {
    const fakePdf = Buffer.from("%PDF-1.4\nfake content\n%%EOF\n");
    const signed = signPdf(fakePdf, "report-123", keyDir);

    const tampered = Buffer.from(signed.pdfBytes);
    tampered[10] = (tampered[10]! + 1) % 256; // flip one byte before the trailer

    expect(() => verifyPdfSignature(tampered, keyDir)).toThrow(
      /content hash|hash mismatch/i,
    );
  });

  it("throws when the trailer's pdfHash is tampered", () => {
    const fakePdf = Buffer.from("%PDF-1.4\nfake content\n%%EOF\n");
    const signed = signPdf(fakePdf, "report-123", keyDir);

    const text = signed.pdfBytes.toString("utf8");
    const tamperedText = text.replace(signed.pdfHash, "f".repeat(64));
    const tampered = Buffer.from(tamperedText, "utf8");

    expect(() => verifyPdfSignature(tampered, keyDir)).toThrow(/hash mismatch/i);
  });

  it("throws key not found when verifying against a different (empty) keyDir", () => {
    const fakePdf = Buffer.from("%PDF-1.4\nfake content\n%%EOF\n");
    const signed = signPdf(fakePdf, "report-123", keyDir);

    const otherKeyDir = mkdtempSync(join(tmpdir(), "awos-sig-other-"));
    expect(() => verifyPdfSignature(signed.pdfBytes, otherKeyDir)).toThrow(
      /key not found/i,
    );
  });
});
