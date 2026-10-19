import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminUploadForm } from "./admin-upload-form";

describe("admin upload selection", () => {
  it("offers a labeled native picker and sends only file facts to the draft action", () => {
    const html = renderToStaticMarkup(<AdminUploadForm maxBytes={2_000_000_000} extensions={["mp4","mkv"]} action={async () => ({ error: "" })} />);
    expect(html).toContain('for="upload-file"');
    expect(html).toContain('type="file"');
    const fileInput = html.match(/<input[^>]*type="file"[^>]*>/)?.[0];
    expect(fileInput).toBeDefined();
    expect(fileInput).not.toMatch(/\sname=/);
    expect(html).toContain('name="fileName"');
    expect(html).toContain('name="sizeBytes"');
    expect(html).toContain("Create upload draft");
  });

  it("shows the configured file limit and supported containers", () => {
    const html = renderToStaticMarkup(<AdminUploadForm maxBytes={500_000_000} extensions={["mp4"]} action={async () => ({ error: "" })} />);
    expect(html).toContain("Maximum 0.5 GB");
    expect(html).toContain('accept=".mp4"');
    expect(html).toContain("Creating a draft saves the filename and size.");
  });
});
