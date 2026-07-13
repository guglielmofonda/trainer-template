import { promises as fs } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function TheoryPage() {
  const file = path.join(process.cwd(), "docs", "THEORY.md");
  const md = await fs.readFile(file, "utf8");
  const html = await marked.parse(md, { gfm: true });

  return (
    <div className="pb-16">
      <PageHeader
        title="Theory &amp; rationale"
        sub="The science the engine encodes — the core of the project."
      />
      <div className="px-5 py-8 sm:px-8">
        <article
          className="theory mx-auto"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
