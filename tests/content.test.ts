import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentReader, findConverter, converter, processText, listPdfImages, converterDirectories } from "../src/content";

test("converter paths use the selected profile and explicit configuration", () => {
  const paths = converterDirectories({SCIENCE_LOCAL_PROFILE: '/tmp/test-profile', CHIMERIC_CONVERTER_PATH: '/tmp/test-converters', CONDA_PREFIX: '/tmp/test-conda', PATH: '/usr/bin'});
  expect(paths).toContain('/tmp/test-profile/conda/envs/r/bin');
  expect(paths).toContain('/tmp/test-converters');
  expect(paths).toContain('/tmp/test-conda/bin');
  expect(converterDirectories({}).some(path => path.includes('/work/') || path.includes('/Users/'))).toBe(false);
});

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// Minimal valid PDF with text "Hello Chimeric PDF"
const validPdfBase64 = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 44 >> stream
BT /F1 24 Tf 100 700 Td (Hello Chimeric PDF) Tj ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f\x20
0000000009 00000 n\x20
0000000058 00000 n\x20
0000000115 00000 n\x20
0000000244 00000 n\x20
0000000337 00000 n\x20
trailer << /Size 6 /Root 1 0 R >>
startxref
414
%%EOF`).toString("base64");

// Minimal blank PDF with no text layer (page with no text stream)
const blankPdfBase64 = Buffer.from(`%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj
xref
0 4
0000000000 65535 f\x20
0000000009 00000 n\x20
0000000058 00000 n\x20
0000000115 00000 n\x20
trailer << /Size 4 /Root 1 0 R >>
startxref
193
%%EOF`).toString("base64");

// Minimal valid DOCX document with text "Hello from DOCX document"
const validDocxBase64 = "UEsDBBQAAAAAAEaGYV15bjPXrQEAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz48VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyI+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48RGVmYXVsdCBFeHRlbnNpb249InhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3dvcmQvZG9jdW1lbnQueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LndvcmRwcm9jZXNzaW5nbWwuZG9jdW1lbnQubWFpbit4bWwiLz48L1R5cGVzPlBLAwQUAAAAAABGhmFdm/036ikBAAApAQAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/PjxSZWxhdGlvbnNoaXBzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMiPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDEiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvb2ZmaWNlRG9jdW1lbnQiIFRhcmdldD0id29yZC9kb2N1bWVudC54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAEaGYV2hl+704QAAAOEAAAARAAAAd29yZC9kb2N1bWVudC54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+PHc6ZG9jdW1lbnQgeG1sbnM6dz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3dvcmRwcm9jZXNzaW5nbWwvMjAwNi9tYWluIj48dzpib2R5Pjx3OnA+PHc6cj48dzp0PkhlbGxvIGZyb20gRE9DWCBkb2N1bWVudDwvdzp0PjwvdzpyPjwvdzpwPjwvdzpib2R5Pjwvdzpkb2N1bWVudD5QSwECFAMUAAAAAABGhmFdeW4z160BAACtAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAAAEaGYV2b/TfqKQEAACkBAAALAAAAAAAAAAAAAACAAd4BAABfcmVscy8ucmVsc1BLAQIUAxQAAAAAAEaGYV2hl+704QAAAOEAAAARAAAAAAAAAAAAAACAATADAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAABABAAAAAA=";

function reader() {
  const dir = mkdtempSync(join(tmpdir(), "chimeric-content-"));
  return { value: new ContentReader(dir), dir, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test("image content validates its declared media type before forwarding bytes", async () => {
  const r = reader();
  try {
    const content = await r.value.content({ type: "image", source: { type: "base64", media_type: "image/png", data: png } }, true);
    expect(content[0].mimeType).toBe("image/png");
    await expect(r.value.content({ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }, true)).rejects.toThrow("do not match");
  } finally { r.close(); }
});

test("base64 and PDF inputs reject malformed or oversized representations", async () => {
  const r = reader();
  try {
    await expect(r.value.sourceBytes({ type: "base64", data: "not-base64" })).rejects.toThrow("invalid base64");
    await expect(r.value.sourceBytes({ type: "base64", data: "A".repeat(4 * Math.ceil(50 * 1024 * 1024 / 3) + 4) })).rejects.toThrow("50 MiB");
    await expect(r.value.content({ type: "document", source: { type: "base64", media_type: "application/pdf", data: Buffer.from("plain text").toString("base64") } }, false)).rejects.toThrow("valid PDF header");
  } finally { r.close(); }
});

test("valid WebP remains accepted and truncated containers fail", async () => {
  const r = reader();
  const webp = "UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++ldotRJUvJ+iMAAA";
  try {
    const content = await r.value.content({ type: "image", source: { type: "base64", media_type: "image/webp", data: webp } }, true);
    expect(content[0].mimeType).toBe("image/webp");
    await expect(r.value.content({ type: "image", source: { type: "base64", media_type: "image/webp", data: Buffer.from(webp, "base64").subarray(0, 20).toString("base64") } }, true)).rejects.toThrow("do not match");
  } finally { r.close(); }
});

test("tool locator searches candidate paths and reports missing converters gracefully", () => {
  const pdftotext = findConverter("pdftotext");
  expect(pdftotext).toBeTruthy();
  expect(pdftotext?.endsWith("/pdftotext")).toBe(true);

  const pandoc = findConverter("pandoc");
  expect(pandoc).toBeTruthy();
  expect(pandoc?.endsWith("/pandoc")).toBe(true);

  expect(() => converter("nonexistent_binary_tool_xyz")).toThrow("required document converter is unavailable: nonexistent_binary_tool_xyz");
});

test("PDF document conversion extracts text and visual input via Poppler", async () => {
  const r = reader();
  try {
    const content = await r.value.content({
      type: "document",
      title: "Test PDF",
      source: { type: "base64", media_type: "application/pdf", data: validPdfBase64 },
    }, true);
    expect(content.length).toBeGreaterThanOrEqual(1);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Hello Chimeric PDF");
    expect(content[0].text).toContain("Document: Test PDF");
    // Visual page rendering
    const pageImage = content.find((c: any) => c.type === "image");
    expect(pageImage).toBeDefined();
    expect(pageImage.mimeType).toBe("image/png");
  } finally { r.close(); }
});

test("Poppler pdfimages inspection lists embedded streams", async () => {
  const r = reader();
  try {
    const filePath = join(r.dir, "test.pdf");
    writeFileSync(filePath, Buffer.from(validPdfBase64, "base64"));
    const listing = await listPdfImages(filePath);
    expect(typeof listing).toBe("string");
    expect(listing).toContain("page");
  } finally { r.close(); }
});

test("Scanned PDF with empty text triggers OCR fallback or graceful notification", async () => {
  const r = reader();
  try {
    const content = await r.value.content({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: blankPdfBase64 },
    }, false);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("scanned image");
  } finally { r.close(); }
});

test("DOCX document conversion extracts clean markdown text via Pandoc", async () => {
  const r = reader();
  try {
    const content = await r.value.content({
      type: "document",
      title: "Docx Test",
      source: {
        type: "base64",
        media_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        data: validDocxBase64,
      },
    }, false);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Document: Docx Test");
    expect(content[0].text).toContain("Hello from DOCX document");
  } finally { r.close(); }
});

test("Markdown document conversion preserves content and structure", async () => {
  const r = reader();
  const md = "# Research Hypothesis\n\n- Point A\n- Point B\n";
  try {
    const content = await r.value.content({
      type: "document",
      source: {
        type: "base64",
        media_type: "text/markdown",
        data: Buffer.from(md).toString("base64"),
      },
    }, false);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("# Research Hypothesis");
    expect(content[0].text).toContain("Point A");
  } finally { r.close(); }
});

test("HTML document conversion converts markup to clean markdown", async () => {
  const r = reader();
  const html = "<h1>Chimeric Platform</h1><p>Modern <strong>scientific</strong> workbench.</p>";
  try {
    const content = await r.value.content({
      type: "document",
      source: {
        type: "base64",
        media_type: "text/html",
        data: Buffer.from(html).toString("base64"),
      },
    }, false);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("# Chimeric Platform");
    expect(content[0].text).toContain("**scientific**");
  } finally { r.close(); }
});

test("LaTeX document conversion converts markup to clean markdown", async () => {
  const r = reader();
  const latex = "\\section{Methodology}\nWe evaluate \\textbf{model} performance.\n";
  try {
    const content = await r.value.content({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/x-latex",
        data: Buffer.from(latex).toString("base64"),
      },
    }, false);
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("# Methodology");
    expect(content[0].text).toContain("**model**");
  } finally { r.close(); }
});

test("Unsupported document media types are rejected gracefully", async () => {
  const r = reader();
  try {
    await expect(r.value.content({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        data: Buffer.from("dummy").toString("base64"),
      },
    }, false)).rejects.toThrow("unsupported document media type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  } finally { r.close(); }
});

test("Converter output exceeding 20 MiB is terminated immediately with bounded limit error", async () => {
  const python = Bun.which("python3") || "/usr/bin/python3";
  await expect(
    processText([python, "-c", "import sys; sys.stdout.write('X' * (21 * 1024 * 1024))"])
  ).rejects.toThrow("document converter stdout output exceeds 20 MiB");
});

test("Subprocess exceeding timeout limit is terminated via SIGKILL", async () => {
  await expect(
    processText(["sleep", "5"], undefined, 100)
  ).rejects.toThrow("document conversion timed out after 0.1 seconds");
});
